// ============================================================
// 信令客户端：只负责配对与 WebRTC 协商消息转发，永远不接触文件内容
// 自动排队：连接建立前发出的消息会在 open 后自动补发
// ============================================================
import type { SignalMessage } from '../types'
import { logger } from './logger'

type MessageHandler = (msg: SignalMessage) => void
type StatusHandler = (status: 'open' | 'closed', detail?: string) => void

export class SignalingClient {
  private ws: WebSocket | null = null
  private msgHandlers = new Set<MessageHandler>()
  private statusHandlers = new Set<StatusHandler>()
  private queue: SignalMessage[] = []
  private url = ''

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(
    url: string,
    hello?: { deviceId?: string; name?: string; kind?: string },
  ): Promise<void> {
    this.url = url
    logger.info('signal', `正在连接信令服务器 ${url}`)
    return new Promise((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(url)
      this.ws = ws
      ws.onopen = () => {
        settled = true
        logger.info('signal', `信令已连接（排队消息 ${this.queue.length} 条）`)
        this.send({ type: 'hello', ...(hello || {}) })
        while (this.queue.length) this.rawSend(this.queue.shift()!)
        this.statusHandlers.forEach((fn) => fn('open'))
        resolve()
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as SignalMessage
          if (msg.type !== 'config') {
            logger.debug('signal', `← 收到消息 ${msg.type}`)
          } else {
            logger.info(
              'signal',
              `收到服务器 ICE 配置（${msg.iceServers?.length ?? 0} 组）`,
            )
          }
          this.msgHandlers.forEach((fn) => fn(msg))
        } catch (e) {
          logger.warn('signal', `非法消息已忽略：${(e as Error).message}`)
        }
      }
      ws.onerror = () => {
        logger.error(
          'signal',
          'WebSocket 错误（网络不可达 / 地址错误 / 服务休眠）',
        )
        if (!settled) {
          settled = true
          reject(new Error('无法连接信令服务器，请检查设置中的服务器地址'))
        }
      }
      ws.onclose = (ev) => {
        logger.warn(
          'signal',
          `信令关闭 code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ''}`,
        )
        if (!settled) {
          settled = true
          reject(new Error('信令连接被关闭'))
        }
        this.statusHandlers.forEach((fn) =>
          fn('closed', ev.reason || '连接已断开'),
        )
      }
    })
  }

  send(msg: SignalMessage) {
    if (this.isOpen) this.rawSend(msg)
    else this.queue.push(msg)
  }

  private rawSend(msg: SignalMessage) {
    this.ws?.send(JSON.stringify(msg))
  }

  onMessage(fn: MessageHandler): () => void {
    this.msgHandlers.add(fn)
    return () => this.msgHandlers.delete(fn)
  }

  onStatus(fn: StatusHandler): () => void {
    this.statusHandlers.add(fn)
    return () => this.statusHandlers.delete(fn)
  }

  close() {
    try {
      this.send({ type: 'leave' })
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }

  get serverUrl() {
    return this.url
  }
}
