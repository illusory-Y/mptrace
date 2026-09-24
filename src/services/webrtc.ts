// ============================================================
// WebRTC 点对点传输层
// - 自动选路：host(局域网直连) -> srflx/prflx(公网打洞直连) -> relay(TURN 中转兜底)
// - DataChannel 可靠有序通道，64KiB 分帧，带背压，不会撑爆发送缓冲
// - 双向：发送端选文件；接收端边收边通过 Rust 落盘到用户配置目录
// - 信令只转发 SDP/ICE，文件字节只在 DataChannel 中流动（DTLS 加密）
// ============================================================
import type { SignalingClient } from './signaling'
import type {
  ChannelControl,
  DeviceInfo,
  NetPathKind,
  PeerPhase,
  SignalMessage,
  TransferJob,
  TransferRole,
} from '../types'
import { createReceivedWriter, timestampName, type ReceivedWriter } from './files'
import { logger } from './logger'

const CHUNK_SIZE = 64 * 1024 // 单帧 64KiB，兼容各平台 SCTP 实现
const HIGH_WATER = 1024 * 1024 // 发送缓冲超过 1MiB 时暂停读文件
const LOW_WATER = 256 * 1024 // 回落到 256KiB 以下继续
const SPEED_TICK_MS = 800
// 接收图片只为 OCR 预览保留一份副本；大图直接保存，避免完成时再次分配整张图片导致 Android OOM。
const MAX_PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024

export interface PeerCallbacks {
  onPhase: (phase: PeerPhase, detail?: string) => void
  onCode: (code: string, expiresAt: number) => void
  onJobs: (jobs: TransferJob[]) => void
  onNetPath: (kind: NetPathKind) => void
  onIncomingRequest: () => void
  onReceivedImage: (blob: Blob, savedDisplay: string) => void
  /** 收到某设备的一键重连呼叫，等待用户在 UI 接受 / 拒绝 */
  onIncomingCall: (from: DeviceInfo, callId: string) => void
  /** 配对成功，记住对方设备（写入最近连接） */
  onRememberDevice: (peer: DeviceInfo) => void
  /** 返回当前用户配置的保存目录（保证设置更改后实时生效） */
  getSaveDir: () => string
}

export const NET_PATH_LABEL: Record<NetPathKind, string> = {
  lan: '局域网直连 · 端到端加密',
  public: '公网穿透直连 · 端到端加密',
  relay: 'TURN 服务器中转 · 加密转发（服务器不存储文件）',
  unknown: '正在建立连接…',
}

export class TransferPeer {
  private role: TransferRole | null = null
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private signaling: SignalingClient
  private cb: PeerCallbacks
  private iceServers: RTCIceServer[] = []
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteReady = false
  private jobs: TransferJob[] = []
  private abortIds = new Set<string>()
  private writer: ReceivedWriter | null = null
  private currentRecvId: string | null = null
  private imageChunks: Uint8Array[] | null = null
  private imageBytes = 0
  private recvQueue: Promise<void> = Promise.resolve()
  private speedTimer: number | null = null
  private lastTickBytes = new Map<string, number>()
  private lastKind: NetPathKind = 'unknown'
  private detached: (() => void) | null = null
  private closed = false

  constructor(signaling: SignalingClient, cb: PeerCallbacks) {
    this.signaling = signaling
    this.cb = cb
    this.detached = signaling.onMessage((m) => this.onSignal(m))
  }

  // ---------------- 对外生命周期 ----------------

  /** 数据通道是否已连通（其他页面据此决定能否"直接发送"） */
  get isChannelOpen(): boolean {
    return this.channel?.readyState === 'open'
  }

  /** 接收端：创建房间，等待配对码 */
  async startAsReceiver(iceServers: RTCIceServer[]) {
    this.reset()
    this.role = 'receiver'
    this.iceServers = iceServers
    this.createPc()
    this.cb.onPhase('waiting')
    this.signaling.send({ type: 'create' })
  }

  /** 发送端：凭配对码加入房间 */
  async startAsSender(code: string, iceServers: RTCIceServer[]) {
    this.reset()
    this.role = 'sender'
    this.iceServers = iceServers
    this.createPc()
    this.pc!.ondatachannel = (ev) => this.bindChannel(ev.channel)
    this.cb.onPhase('joining')
    this.signaling.send({ type: 'join', code })
  }

  /** 接收端用户在弹窗中点"接受" */
  async accept() {
    if (!this.pc || this.role !== 'receiver') return
    await this.beginOffer()
  }

  /** WebRTC host：建数据通道并发送 offer（配对码接受 / 设备呼叫接通后复用） */
  private async beginOffer() {
    if (!this.pc) return
    this.cb.onPhase('connecting')
    const ch = this.pc.createDataChannel('files', { ordered: true })
    this.bindChannel(ch)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    this.signaling.send({ type: 'offer', sdp: offer })
  }

  /** 接收端拒绝连接 */
  reject() {
    this.signaling.send({ type: 'leave' })
    this.cb.onPhase('closed', '已拒绝连接请求')
    this.teardown()
  }

  /** 一键重连：呼叫最近设备（本端为 WebRTC guest，等 offer 回 answer） */
  async startCall(targetDeviceId: string, iceServers: RTCIceServer[]) {
    this.reset()
    this.role = 'sender'
    this.iceServers = iceServers
    this.createPc()
    this.pc!.ondatachannel = (ev) => this.bindChannel(ev.channel)
    this.cb.onPhase('joining')
    this.signaling.send({ type: 'call', target: targetDeviceId })
  }

  /** 被呼叫方接受重连（本端为 WebRTC host，服务端接通后在 call-accepted 里发 offer） */
  async acceptCall(callId: string, iceServers: RTCIceServer[]) {
    this.reset()
    this.role = 'receiver'
    this.iceServers = iceServers
    this.createPc()
    this.cb.onPhase('connecting')
    this.signaling.send({ type: 'call-accept', callId })
  }

  /** 被呼叫方拒绝重连 */
  rejectCall(callId: string) {
    this.signaling.send({ type: 'call-reject', callId })
    this.cb.onPhase('idle')
    this.teardown()
  }

  close() {
    this.closed = true
    try {
      this.signaling.send({ type: 'leave' })
    } catch {
      /* ignore */
    }
    this.teardown()
    this.cb.onPhase('closed', '连接已结束')
  }

  // ---------------- 信令处理 ----------------

  private onSignal(msg: SignalMessage) {
    switch (msg.type) {
      case 'created':
        this.cb.onCode(msg.code, msg.expiresAt)
        this.cb.onPhase('waiting')
        break
      case 'joined':
        if (msg.peer) this.cb.onRememberDevice(msg.peer)
        this.cb.onPhase('connecting')
        break
      case 'peer-join':
        if (msg.peer) this.cb.onRememberDevice(msg.peer)
        this.cb.onPhase('incoming-request')
        this.cb.onIncomingRequest()
        break
      // ---- 一键重连 ----
      case 'incoming-call':
        this.cb.onIncomingCall(msg.from, msg.callId)
        break
      case 'call-connected':
        this.cb.onPhase('connecting')
        break
      case 'call-accepted':
        void this.beginOffer()
        break
      case 'call-rejected':
        this.cb.onPhase('error', '对方拒绝了重连请求')
        this.teardown()
        break
      case 'offer':
        void this.handleOffer(msg.sdp)
        break
      case 'answer':
        void this.handleAnswer(msg.sdp)
        break
      case 'candidate':
        if (this.remoteReady) {
          void this.pc?.addIceCandidate(new RTCIceCandidate(msg.candidate))
        } else {
          this.pendingCandidates.push(msg.candidate)
        }
        break
      case 'peer-left':
        logger.warn('signal', '对方已离开')
        this.cb.onPhase('closed', '对方已离开')
        this.teardown()
        break
      case 'expired':
        this.cb.onPhase('error', '配对码已过期（5 分钟有效），请重新生成')
        this.teardown()
        break
      case 'error':
        logger.error('signal', `服务器错误：${msg.message}`)
        this.cb.onPhase('error', msg.message)
        break
    }
  }

  private async handleAnswer(sdp: RTCSessionDescriptionInit) {
    if (!this.pc) return
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(sdp))
      this.remoteReady = true
      await this.flushCandidates()
    } catch (e) {
      this.cb.onPhase('error', `应答协商失败：${(e as Error).message}`)
    }
  }

  private async handleOffer(sdp: RTCSessionDescriptionInit) {
    if (!this.pc) return
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(sdp))
      this.remoteReady = true
      await this.flushCandidates()
      const answer = await this.pc.createAnswer()
      await this.pc.setLocalDescription(answer)
      this.signaling.send({ type: 'answer', sdp: answer })
    } catch (e) {
      this.cb.onPhase('error', `连接协商失败：${(e as Error).message}`)
    }
  }

  private async flushCandidates() {
    while (this.pendingCandidates.length && this.pc) {
      await this.pc.addIceCandidate(new RTCIceCandidate(this.pendingCandidates.shift()!))
    }
  }

  // ---------------- PC / Channel ----------------

  private createPc() {
    logger.info(
      'webrtc',
      `创建 PeerConnection（ICE 服务器 ${this.iceServers.length} 组）`,
    )
    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
    })
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const c = ev.candidate
        logger.debug(
          'ice',
          `本端候选 ${c.type} ${c.protocol} ${c.address || ''}:${c.port || ''}` +
            (c.relatedAddress ? ` (via ${c.relatedAddress})` : ''),
        )
        this.signaling.send({
          type: 'candidate',
          candidate: c.toJSON() as RTCIceCandidateInit,
        })
      } else {
        logger.info('ice', '本端候选收集完成')
      }
    }
    this.pc.onicegatheringstatechange = () => {
      logger.debug('ice', `gathering=${this.pc?.iceGatheringState}`)
    }
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc?.iceConnectionState
      logger.info('ice', `ICE 连接状态=${s}`)
      if (s === 'failed') void this.dumpIceFailure('ICE failed')
    }
    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState
      logger.info('webrtc', `连接状态=${s}`)
      if (s === 'connected') {
        this.cb.onPhase('connected')
      } else if (s === 'failed') {
        // disconnected 多为网络抖动，ICE 会自行恢复，只有 failed 才判定失败
        void this.dumpIceFailure('connection failed')
        this.cb.onPhase('error', '直连与中转均失败，请检查双方网络后重试')
      }
    }
  }

  /** 连接失败时把候选对与本端候选类型写入日志，判断是 STUN 不通还是缺少 TURN */
  private async dumpIceFailure(reason: string) {
    if (!this.pc) return
    try {
      const stats = await this.pc.getStats()
      const localKinds = new Set<string>()
      let pairs = 0
      stats.forEach((report) => {
        const r = report as RTCStats & Record<string, unknown>
        if (r.type === 'local-candidate' && r.candidateType) {
          localKinds.add(String(r.candidateType))
        }
        if (r.type === 'candidate-pair') {
          pairs++
          logger.debug(
            'ice',
            `候选对 state=${r.state} nominated=${r.nominated === true}`,
          )
        }
      })
      logger.error(
        'ice',
        `${reason}；本端候选类型=[${[...localKinds].join(',') || '无'}]，候选对=${pairs}`,
      )
    } catch (e) {
      logger.error('ice', `${reason}（读取统计失败：${(e as Error).message}）`)
    }
  }

  private bindChannel(ch: RTCDataChannel) {
    this.channel = ch
    ch.binaryType = 'arraybuffer'
    ch.onopen = () => {
      this.closed = false
      logger.info('channel', '数据通道已打开，可双向传输')
      this.cb.onPhase('connected')
      this.startSpeedTimer()
      this.startNetPathProbe()
    }
    ch.onclose = () => {
      logger.warn('channel', '数据通道已关闭')
      this.stopSpeedTimer()
      // 未完成任务标记为中断
      let changed = false
      this.jobs.forEach((j) => {
        if (j.state === 'transferring' || j.state === 'pending') {
          j.state = 'canceled'
          changed = true
        }
      })
      if (changed) this.emitJobs()
    }
    ch.onerror = (ev) => {
      const detail = (ev as unknown as { error?: { message?: string } }).error
        ?.message
      logger.error('channel', `数据通道异常：${detail || '未知错误'}`)
      this.cb.onPhase('error', '数据通道异常')
    }
    ch.onmessage = (ev) => {
      // 串行化接收，保证分帧顺序
      this.recvQueue = this.recvQueue.then(() => this.handleFrame(ev.data))
    }
  }

  // ---------------- 接收侧 ----------------

  private async handleFrame(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      let ctrl: ChannelControl
      try {
        ctrl = JSON.parse(data) as ChannelControl
      } catch {
        return // 非预期文本帧直接丢弃，避免中断接收队列
      }
      if (ctrl.t === 'meta') await this.onMeta(ctrl)
      else if (ctrl.t === 'done') await this.onDone(ctrl.id)
      else if (ctrl.t === 'cancel') await this.onRemoteCancel(ctrl.id)
      return
    }
    const bytes = new Uint8Array(data)
    const job = this.jobs.find((j) => j.id === this.currentRecvId)
    if (!job || !this.writer) return
    await this.writer.append(bytes)
    if (this.imageChunks) {
      if (this.imageBytes + bytes.length <= MAX_PREVIEW_IMAGE_BYTES) {
        this.imageChunks.push(bytes)
        this.imageBytes += bytes.length
      } else {
        // 文件仍完整保存，但不再为 OCR 预览继续复制内存。
        this.imageChunks = null
        this.imageBytes = 0
      }
    }
    job.transferred += bytes.length
  }

  private async onMeta(ctrl: Extract<ChannelControl, { t: 'meta' }>) {
    this.currentRecvId = ctrl.id
    const name = timestampName(ctrl.name)
    logger.info(
      'recv',
      `开始接收 ${ctrl.name}（${ctrl.size} 字节，${ctrl.mime || '未知类型'}）`,
    )
    const job: TransferJob = {
      id: ctrl.id,
      name,
      size: ctrl.size,
      mime: ctrl.mime || 'application/octet-stream',
      direction: 'receiver',
      state: 'transferring',
      transferred: 0,
      speed: 0,
    }
    this.upsertJob(job)
    this.writer = createReceivedWriter()
    try {
      await this.writer.create(this.cb.getSaveDir(), name, job.mime)
    } catch (e) {
      job.state = 'error'
      job.error = (e as Error).message
      logger.error('recv', `创建保存会话失败：${job.error}`)
      this.writer = null
      this.currentRecvId = null
      this.emitJobs()
      return
    }
    this.imageChunks = job.mime.startsWith('image/') ? [] : null
    this.imageBytes = 0
  }

  private async onDone(id: string) {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    const writer = this.writer
    try {
      if (!writer) throw new Error('接收写入会话不存在')
      const saved = await writer.finish()
      job.state = 'done'
      job.transferred = job.size
      job.savedTo = saved.display
      job.savedUri = saved.uri
      job.savedMime = job.mime
      logger.info('recv', `接收完成：${saved.display || job.name}`)
      this.emitJobs()
      if (this.imageChunks) {
        const total = this.imageChunks.reduce((s, c) => s + c.length, 0)
        const merged = new Uint8Array(total)
        let off = 0
        for (const c of this.imageChunks) {
          merged.set(c, off)
          off += c.length
        }
        const blob = new Blob([merged], { type: job.mime })
        this.cb.onReceivedImage(blob, saved.display)
      }
    } catch (e) {
      await writer?.cancel().catch(() => {})
      job.state = 'error'
      job.error = (e as Error).message
      logger.error('recv', `接收失败：${job.error}`)
      this.emitJobs()
    } finally {
      this.writer = null
      this.imageChunks = null
      this.imageBytes = 0
      this.currentRecvId = null
    }
  }

  private async onRemoteCancel(id: string) {
    await this.writer?.cancel()
    this.writer = null
    this.imageChunks = null
    this.currentRecvId = null
    const job = this.jobs.find((j) => j.id === id)
    if (job) {
      job.state = 'canceled'
      this.emitJobs()
    }
    this.abortIds.add(id)
  }

  // ---------------- 发送侧 ----------------

  async enqueueFiles(files: File[]) {
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('连接尚未建立，无法发送')
    }
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const job: TransferJob = {
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        direction: 'sender',
        state: 'transferring',
        transferred: 0,
        speed: 0,
      }
      this.upsertJob(job)
      await this.sendOne(id, file)
    }
  }

  private async sendOne(id: string, file: File) {
    const ch = this.channel!
    const job = this.jobs.find((j) => j.id === id)!
    const meta: ChannelControl = {
      t: 'meta',
      id,
      name: file.name,
      size: file.size,
      mime: file.type,
    }
    logger.info('send', `开始发送 ${file.name}（${file.size} 字节）`)
    ch.send(JSON.stringify(meta))
    let offset = 0
    try {
      while (offset < file.size) {
        if (this.abortIds.has(id)) {
          job.state = 'canceled'
          this.emitJobs()
          return
        }
        const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size))
        const buf = new Uint8Array(await slice.arrayBuffer())
        if (ch.bufferedAmount > HIGH_WATER) await this.waitDrain()
        ch.send(buf)
        offset += buf.length
        job.transferred = offset
      }
      const done: ChannelControl = { t: 'done', id }
      ch.send(JSON.stringify(done))
      job.state = 'done'
      job.transferred = job.size
      logger.info('send', `发送完成：${file.name}`)
    } catch (e) {
      job.state = 'error'
      job.error = (e as Error).message
      logger.error('send', `发送失败：${(e as Error).message}`)
    } finally {
      this.emitJobs()
    }
  }

  private waitDrain(): Promise<void> {
    const ch = this.channel!
    return new Promise((resolve) => {
      ch.bufferedAmountLowThreshold = LOW_WATER
      const handler = () => {
        if (ch.bufferedAmount <= LOW_WATER) {
          ch.removeEventListener('bufferedamountlow', handler)
          resolve()
        }
      }
      ch.addEventListener('bufferedamountlow', handler)
    })
  }

  /** 任意一方取消某个任务 */
  cancelJob(id: string) {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    this.abortIds.add(id)
    const ctrl: ChannelControl = { t: 'cancel', id }
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(ctrl))
    if (job.direction === 'receiver') {
      void this.writer?.cancel()
      this.writer = null
    }
    job.state = 'canceled'
    this.emitJobs()
  }

  // ---------------- 进度/速度/选路探测 ----------------

  private startSpeedTimer() {
    this.stopSpeedTimer()
    this.lastTickBytes.clear()
    this.speedTimer = window.setInterval(() => {
      let changed = false
      for (const job of this.jobs) {
        if (job.state !== 'transferring') continue
        const prev = this.lastTickBytes.get(job.id) ?? 0
        job.speed = ((job.transferred - prev) * 1000) / SPEED_TICK_MS
        this.lastTickBytes.set(job.id, job.transferred)
        changed = true
      }
      if (changed) this.emitJobs()
      void this.refreshNetPath()
    }, SPEED_TICK_MS)
  }

  private stopSpeedTimer() {
    if (this.speedTimer !== null) {
      clearInterval(this.speedTimer)
      this.speedTimer = null
    }
  }

  private netPathTimer: number | null = null
  private startNetPathProbe() {
    this.netPathTimer = window.setInterval(() => void this.refreshNetPath(), 2500)
  }

  private async refreshNetPath() {
    if (!this.pc) return
    const stats = await this.pc.getStats()
    let kind: NetPathKind = 'unknown'
    stats.forEach((report) => {
      const r = report as RTCStats & Record<string, unknown>
      if (
        r.type === 'candidate-pair' &&
        ((r.nominated as boolean) || (r.selected as boolean)) &&
        r.state === 'succeeded'
      ) {
        const local = stats.get(r.localCandidateId as string) as
          | (RTCStats & { candidateType?: string })
          | undefined
        if (local?.candidateType === 'relay') kind = 'relay'
        else if (local?.candidateType === 'host') kind = 'lan'
        else if (local?.candidateType) kind = 'public'
      }
    })
    if (kind !== 'unknown' && kind !== this.lastKind) {
      this.lastKind = kind
      this.cb.onNetPath(kind)
    }
  }

  // ---------------- 任务表 ----------------

  private upsertJob(job: TransferJob) {
    const idx = this.jobs.findIndex((j) => j.id === job.id)
    if (idx >= 0) this.jobs[idx] = job
    else this.jobs.push(job)
    this.emitJobs()
  }

  private emitJobs() {
    this.cb.onJobs(this.jobs.map((j) => ({ ...j })))
  }

  // ---------------- 清理 ----------------

  private reset() {
    this.stopSpeedTimer()
    if (this.netPathTimer !== null) {
      clearInterval(this.netPathTimer)
      this.netPathTimer = null
    }
    this.jobs = []
    this.pendingCandidates = []
    this.abortIds.clear()
    this.remoteReady = false
    this.lastKind = 'unknown'
    this.emitJobs()
  }

  private teardown() {
    this.stopSpeedTimer()
    if (this.netPathTimer !== null) {
      clearInterval(this.netPathTimer)
      this.netPathTimer = null
    }
    try {
      this.channel?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close()
    } catch {
      /* ignore */
    }
    this.channel = null
    this.pc = null
  }

  dispose() {
    this.teardown()
    this.detached?.()
  }
}
