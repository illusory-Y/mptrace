<script setup lang="ts">
// 全网通互传页：配对码/二维码 -> WebRTC 自动选路 -> 双向分块传输 -> 统一目录落盘
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import { useAppStore } from '../stores/app'
import { useOcrStore } from '../stores/ocr'
import { SignalingClient } from '../services/signaling'
import { NET_PATH_LABEL, TransferPeer } from '../services/webrtc'
import { setActivePeer } from '../services/peer-session'
import { makePairQr, parsePairQr } from '../services/qr'
import { formatBytes, formatSpeed } from '../services/files'
import type { NetPathKind, PeerPhase, TransferJob } from '../types'

const app = useAppStore()
const ocrStore = useOcrStore()

const role = ref<'' | 'sender' | 'receiver'>('')
const phase = ref<PeerPhase>('idle')
const phaseDetail = ref('')
const signalState = ref<'idle' | 'connecting' | 'open' | 'closed'>('idle')
const code = ref('')
const qrUrl = ref('')
const remainSec = ref(0)
const jobs = ref<TransferJob[]>([])
const netKind = ref<NetPathKind>('unknown')
const showIncoming = ref(false)
const codeInput = ref('')
const toast = ref('')
const dragOver = ref(false)
const scanOpen = ref(false)

const fileInput = ref<HTMLInputElement | null>(null)
const cameraInput = ref<HTMLInputElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)

let signaling: SignalingClient | null = null
let peer: TransferPeer | null = null
let serverIce: RTCIceServer[] = []
let countdownTimer: number | null = null
let scanner: BrowserMultiFormatReader | null = null
let scanControls: IScannerControls | null = null
let toastTimer: number | undefined

onBeforeUnmount(() => fullReset())

function showToast(msg: string) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 4200)
}

function localIceServers(): RTCIceServer[] {
  const urls = app.stunUrl
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return urls.length ? [{ urls }] : []
}

function buildIce(): RTCIceServer[] {
  // 服务器下发（含私有 TURN 凭据）优先，本地 STUN 兜底
  const seen = new Set<string>()
  const out: RTCIceServer[] = []
  for (const s of [...serverIce, ...localIceServers()]) {
    const key = JSON.stringify(s)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(s)
    }
  }
  return out
}

async function ensureSignal(): Promise<SignalingClient> {
  if (signaling?.isOpen) return signaling
  if (!app.signalUrl) {
    throw new Error('未配置信令服务器地址：请到「设置」页填写你部署的信令服务器地址')
  }
  signalState.value = 'connecting'
  const client = new SignalingClient()
  client.onMessage((msg) => {
    if (msg.type === 'config') serverIce = msg.iceServers
  })
  client.onStatus((s, detail) => {
    signalState.value = s === 'open' ? 'open' : 'closed'
    if (s === 'closed' && role.value) {
      phase.value = 'error'
      phaseDetail.value = detail || '信令连接断开'
    }
  })
  await client.connect(app.signalUrl)
  signaling = client
  signalState.value = 'open'
  return client
}

function makePeer(client: SignalingClient): TransferPeer {
  return new TransferPeer(client, {
    getSaveDir: () => app.effectiveDir,
    onPhase: (p, detail) => {
      phase.value = p
      phaseDetail.value = detail || ''
      showIncoming.value = p === 'incoming-request'
    },
    onCode: async (c, expiresAt) => {
      code.value = c
      qrUrl.value = await makePairQr(c, app.signalUrl)
      startCountdown(expiresAt)
    },
    onJobs: (list) => (jobs.value = list),
    onNetPath: (k) => (netKind.value = k),
    onIncomingRequest: () => (showIncoming.value = true),
    onReceivedImage: (blob, display) => {
      ocrStore.pushIncoming(blob, display || '接收的图片')
      showToast('图片接收完成，已自动载入「识别」页，可直接识别')
    },
  })
}

function registerPeer(client: SignalingClient): TransferPeer {
  const p = makePeer(client)
  setActivePeer(p)
  return p
}

async function becomeReceiver() {
  try {
    softReset()
    role.value = 'receiver'
    netKind.value = 'unknown'
    const client = await ensureSignal()
    peer = registerPeer(client)
    await tick(220) // 等服务端把 TURN/STUN 配置下发到位
    await peer.startAsReceiver(buildIce())
  } catch (e) {
    showToast((e as Error).message)
    phase.value = 'error'
  }
}

async function becomeSender() {
  try {
    softReset()
    role.value = 'sender'
    netKind.value = 'unknown'
    const client = await ensureSignal()
    peer = registerPeer(client)
    await tick(220)
    phase.value = 'idle'
    phaseDetail.value = '请输入对方屏幕上的 6 位配对码，或扫描二维码'
  } catch (e) {
    showToast((e as Error).message)
    phase.value = 'error'
  }
}

/** 快捷扫码：自动成为发送方并打开摄像头扫码 */
async function quickScan() {
  try {
    await becomeSender()
    if (role.value === 'sender') {
      await openScan()
    }
  } catch (e) {
    showToast((e as Error).message)
  }
}

async function joinByCode() {
  const c = codeInput.value.trim()
  if (!/^\d{6}$/.test(c)) return showToast('配对码应为 6 位数字')
  try {
    await peer?.startAsSender(c, buildIce())
  } catch (e) {
    showToast((e as Error).message)
  }
}

function acceptIncoming() {
  showIncoming.value = false
  void peer?.accept()
}
function rejectIncoming() {
  showIncoming.value = false
  peer?.reject()
}

function startCountdown(expiresAt: number) {
  if (countdownTimer) clearInterval(countdownTimer)
  const update = () => {
    remainSec.value = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
    if (remainSec.value <= 0 && countdownTimer) clearInterval(countdownTimer)
  }
  update()
  countdownTimer = window.setInterval(update, 1000)
}

function pickFiles() {
  fileInput.value?.click()
}
async function onFilesChosen(ev: Event) {
  const input = ev.target as HTMLInputElement
  if (input.files?.length) await sendFiles(Array.from(input.files))
  input.value = ''
}
async function onCameraChosen(ev: Event) {
  const input = ev.target as HTMLInputElement
  if (input.files?.length) await sendFiles(Array.from(input.files))
  input.value = ''
}

async function sendFiles(files: File[]) {
  try {
    await peer?.enqueueFiles(files)
  } catch (e) {
    showToast((e as Error).message)
  }
}

function onDrop(ev: DragEvent) {
  dragOver.value = false
  const files = ev.dataTransfer?.files
  if (files?.length) void sendFiles(Array.from(files))
}

function cancelJob(id: string) {
  peer?.cancelJob(id)
}

// ---------- 扫码 ----------
async function openScan() {
  scanOpen.value = true
  await nextTick()
  try {
    scanner = new BrowserMultiFormatReader()
    scanControls = await scanner.decodeFromVideoDevice(undefined, videoEl.value!, (result) => {
      if (!result) return
      const parsed = parsePairQr(result.getText())
      if (!parsed) return
      codeInput.value = parsed.code
      // 只有二维码携带真实远程地址时才覆盖；localhost/127/0.0.0.0 对手机无意义，忽略
      if (parsed.server && !/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(parsed.server)) {
        if (parsed.server !== app.signalUrl) app.setSignalUrl(parsed.server)
      }
      void closeScan()
      void joinByCode()
    })
  } catch (e) {
    showToast(`无法打开摄像头：${(e as Error).message}（请确认已授予相机权限）`)
    scanOpen.value = false
  }
}
async function closeScan() {
  scanControls?.stop()
  scanControls = null
  scanner = null
  scanOpen.value = false
}

// ---------- 重置 ----------
function softReset() {
  peer?.dispose()
  peer = null
  setActivePeer(null)
  jobs.value = []
  code.value = ''
  qrUrl.value = ''
  netKind.value = 'unknown'
  showIncoming.value = false
  if (countdownTimer) clearInterval(countdownTimer)
  remainSec.value = 0
}

function fullReset() {
  softReset()
  signaling?.close()
  signaling = null
  serverIce = []
  signalState.value = 'idle'
  role.value = ''
  phase.value = 'idle'
  phaseDetail.value = ''
  void closeScan()
}

function tick(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function pct(job: TransferJob): number {
  if (!job.size) return 0
  return Math.min(100, Math.round((job.transferred / job.size) * 100))
}

function jobStateLabel(s: TransferJob['state']): string {
  return { pending: '等待中', transferring: '传输中', done: '已完成', canceled: '已取消', error: '失败' }[s]
}

const phaseLabel: Record<PeerPhase, string> = {
  idle: '未开始',
  waiting: '等待对方输入配对码…',
  joining: '正在加入…',
  'incoming-request': '收到连接请求',
  connecting: '正在建立加密通道（自动选路）…',
  connected: '已连接，可以传输文件',
  closed: '连接已结束',
  error: '出现问题',
}

function onlyDigits(v: string) {
  codeInput.value = v.replace(/\D/g, '').slice(0, 6)
}
</script>

<template>
  <section>
    <!-- 角色选择 -->
    <div class="card" v-if="!role">
      <h3>选择你的角色（无需登录、无需加好友）</h3>
      <button class="btn btn-primary btn-lg btn-block" @click="quickScan">扫码连接</button>
      <p class="muted" style="text-align: center; margin: 10px 0">— 或手动选择角色、输入配对码 —</p>
      <div class="grid-2">
        <button class="btn btn-lg" @click="becomeSender">我要发送</button>
        <button class="btn btn-lg" @click="becomeReceiver">我要接收</button>
      </div>
      <p class="muted" style="margin: 10px 0 0">
        电脑端打开网页生成二维码，手机点「扫码连接」即可；摄像头不可用时，可手动选角色，输入对方屏幕上的 6 位配对码。
      </p>
    </div>

    <!-- 接收端面板 -->
    <div class="card" v-if="role === 'receiver'">
      <div class="row" style="justify-content: space-between">
        <h3 style="margin: 0">接收端</h3>
        <button class="btn btn-ghost" @click="fullReset">结束 / 重选角色</button>
      </div>

      <template v-if="phase === 'waiting' || phase === 'connecting' || phase === 'incoming-request'">
        <p class="muted" style="margin: 10px 0 4px">把下面 6 位配对码告诉对方，或让对方扫描二维码（5 分钟内有效）</p>
        <div class="pair-code">{{ code || '------' }}</div>
        <div v-if="qrUrl" style="text-align: center">
          <img :src="qrUrl" alt="配对二维码" style="width: 220px; height: 220px" />
        </div>
        <p class="muted" style="text-align: center">
          配对码剩余 {{ remainSec }} 秒，过期后请重新生成
        </p>
      </template>

      <div class="row" style="margin-top: 8px">
        <span class="badge" :class="netKind">
          <span class="dot"></span>{{ NET_PATH_LABEL[netKind] }}
        </span>
      </div>
      <p class="notice info" style="margin-top: 10px">
        当前状态：{{ phaseLabel[phase] }}
        <span v-if="phaseDetail">（{{ phaseDetail }}）</span>
      </p>
      <p class="muted" style="margin-bottom: 0">
        接收的文件将自动保存到：<b>{{ app.effectiveDirDisplay }}</b
        >；接收到的图片会自动进入「识别」页。
      </p>
    </div>

    <!-- 发送端面板 -->
    <div class="card" v-if="role === 'sender'">
      <div class="row" style="justify-content: space-between">
        <h3 style="margin: 0">发送端</h3>
        <button class="btn btn-ghost" @click="fullReset">结束 / 重选角色</button>
      </div>

      <template v-if="phase === 'idle'">
        <label class="muted" for="code-input">输入对方的 6 位配对码</label>
        <div class="row" style="margin: 6px 0 10px">
          <input
            id="code-input"
            class="input"
            style="flex: 1; letter-spacing: 0.3em; font-size: 1.3rem; text-align: center"
            inputmode="numeric"
            :value="codeInput"
            @input="onlyDigits(($event.target as HTMLInputElement).value)"
            placeholder="------"
          />
          <button class="btn btn-lg" @click="openScan">扫码</button>
        </div>
        <button class="btn btn-primary btn-lg btn-block" @click="joinByCode">发起连接</button>
      </template>

      <template v-else>
        <div class="row" style="margin: 8px 0">
          <span class="badge" :class="netKind">
            <span class="dot"></span>{{ NET_PATH_LABEL[netKind] }}
          </span>
        </div>
        <p class="notice info">
          当前状态：{{ phaseLabel[phase] }}
          <span v-if="phaseDetail">（{{ phaseDetail }}）</span>
        </p>
      </template>
    </div>

    <!-- 连接成功后，双方都可以发送文件（双向互传） -->
    <div class="card" v-if="phase === 'connected'">
      <h3>发送文件给对方</h3>
      <div
        class="drop-zone"
        :class="{ drag: dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
      >
        <p style="margin: 0 0 10px">把文件拖到这里发送（PC），或点按钮选择文件 / 拍照</p>
        <div class="row" style="justify-content: center">
          <button class="btn btn-primary btn-lg" @click="pickFiles">选择文件发送</button>
          <button class="btn btn-lg" @click="cameraInput?.click()">拍照发送</button>
        </div>
        <input ref="fileInput" type="file" multiple hidden @change="onFilesChosen" />
        <input
          ref="cameraInput"
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          @change="onCameraChosen"
        />
      </div>
    </div>

    <!-- 任务列表 -->
    <div class="card" v-if="jobs.length">
      <h3>传输列表</h3>
      <div v-for="job in jobs" :key="job.id" class="file-item">
        <div class="row" style="justify-content: space-between; gap: 8px">
          <div class="file-name spacer">
            {{ job.direction === 'sender' ? '↑ 发送' : '↓ 接收' }}：{{ job.name }}
            <span class="muted">（{{ formatBytes(job.size) }}）</span>
          </div>
          <button
            v-if="job.state === 'transferring'"
            class="btn btn-danger"
            style="min-height: 36px; padding: 0 12px"
            @click="cancelJob(job.id)"
          >
            取消
          </button>
          <span v-else class="muted">{{ jobStateLabel(job.state) }}</span>
        </div>
        <div class="progress" style="margin: 8px 0">
          <span :style="{ width: pct(job) + '%' }"></span>
        </div>
        <div class="muted row" style="justify-content: space-between">
          <span>{{ pct(job) }}% · {{ formatSpeed(job.speed) }}</span>
          <span v-if="job.savedTo">已保存到：{{ job.savedTo }}</span>
          <span v-else-if="job.error" style="color: var(--danger)">{{ job.error }}</span>
        </div>
      </div>
    </div>

    <!-- 固定说明 -->
    <p class="notice">
      文件优先端到端直连（同 WiFi / 公网穿透），极端网络才会经过你自己部署的 TURN
      中转服务器加密转发；信令与中转服务器都不存储、不留存任何文件。
    </p>

    <!-- 收到连接请求弹窗 -->
    <div v-if="showIncoming" class="modal-mask">
      <div class="modal">
        <h2>收到连接请求</h2>
        <p>有设备希望与你建立加密连接，是否接受？请勿接受陌生人的请求。</p>
        <div class="grid-2" style="margin-top: 12px">
          <button class="btn btn-danger btn-lg" @click="rejectIncoming">拒绝</button>
          <button class="btn btn-primary btn-lg" @click="acceptIncoming">接受</button>
        </div>
      </div>
    </div>

    <!-- 扫码层 -->
    <div v-if="scanOpen" class="modal-mask" @click.self="closeScan">
      <div class="modal" style="max-width: 420px">
        <h2>扫描对方二维码</h2>
        <video ref="videoEl" style="width: 100%; border-radius: 10px; background: #000"></video>
        <button class="btn btn-block btn-lg" style="margin-top: 10px" @click="closeScan">取消</button>
      </div>
    </div>

    <div v-if="toast" class="notice info" style="position: sticky; bottom: 12px">{{ toast }}</div>
  </section>
</template>
