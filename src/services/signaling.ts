// ============================================================
// 信令客户端：只负责配对与 WebRTC 协商消息转发，永远不接触文件内容
// 自动排队：连接建立前发出的消息会在 open 后自动补发
// ============================================================
import type { SignalMessage } from '../types'

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

  connect(url: string): Promise<void> {
    this.url = url
    return new Promise((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(url)
      this.ws = ws
      ws.onopen = () => {
        settled = true
        this.send({ type: 'hello' })
        while (this.queue.length) this.rawSend(this.queue.shift()!)
        this.statusHandlers.forEach((fn) => fn('open'))
        resolve()
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as SignalMessage
          this.msgHandlers.forEach((fn) => fn(msg))
        } catch {
          /* 忽略非法消息 */
        }
      }
      ws.onerror = () => {
        if (!settled) {
          settled = true
          reject(new Error('无法连接信令服务器，请检查设置中的服务器地址'))
        }
      }
      ws.onclose = (ev) => {
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
