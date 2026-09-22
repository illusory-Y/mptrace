// ====== 全局共享类型 ======

/** 传输角色 */
export type TransferRole = 'sender' | 'receiver'

/** 连接阶段 */
export type PeerPhase =
  | 'idle' // 未开始
  | 'waiting' // 接收端：等待对方输入配对码
  | 'joining' // 发送端：正在加入房间
  | 'incoming-request' // 接收端：收到连接请求，等待用户确认
  | 'connecting' // WebRTC 协商中
  | 'connected' // 已连接（可传文件）
  | 'closed' // 已结束/对端离开
  | 'error' // 出错

/** 自动选路结果（仅用于展示，用户无需配置） */
export type NetPathKind = 'lan' | 'public' | 'relay' | 'unknown'

/** 单个文件传输任务 */
export interface TransferJob {
  id: string
  name: string
  size: number
  mime: string
  direction: TransferRole
  state: 'pending' | 'transferring' | 'done' | 'canceled' | 'error'
  transferred: number
  /** bytes/s，定时刷新 */
  speed: number
  error?: string
  /** 接收完成后，Tauri 端返回的保存位置描述；浏览器调试模式下为 blobUrl */
  savedTo?: string
  /** 接收到的图片，用于自动载入 OCR */
  imageDataUrl?: string
}

/** 信令服务器下发的 ICE 配置 */
export interface IceConfig {
  iceServers: RTCIceServer[]
  ttlMs: number
}

/** 设备公开信息（用于记住设备 / 一键重连） */
export interface DeviceInfo {
  deviceId: string
  name: string
  kind: 'computer' | 'phone' | 'unknown'
}

/** 最近连接的设备（本地持久化） */
export interface RecentPeer extends DeviceInfo {
  lastConnectedAt: number
}

// ====== 信令协议（服务器只转发这些消息，永远不接触文件内容） ======

export type SignalMessage =
  | { type: 'hello'; deviceId?: string; name?: string; kind?: string }
  | { type: 'leave' }
  | { type: 'config'; iceServers: RTCIceServer[]; ttlMs: number }
  | { type: 'create' }
  | { type: 'created'; code: string; expiresAt: number }
  | { type: 'join'; code: string }
  | { type: 'joined'; peer?: DeviceInfo }
  | { type: 'peer-join'; peerId: string; peer?: DeviceInfo }
  // 设备到设备一键重连（基于持久 deviceId，服务端代为建房间）
  | { type: 'call'; target: string }
  | { type: 'incoming-call'; callId: string; from: DeviceInfo }
  | { type: 'call-accept'; callId: string }
  | { type: 'call-reject'; callId: string }
  | { type: 'call-accepted'; callId: string }
  | { type: 'call-connected'; callId: string }
  | { type: 'call-rejected' }
  // offer/answer/candidate 服务端只在同一房间两端之间透传，不解析内容
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit }
  | { type: 'peer-left' }
  | { type: 'expired' }
  | { type: 'error'; message: string }

// ====== DataChannel 内部控制消息（与二进制分帧分离） ======

export type ChannelControl =
  | { t: 'meta'; id: string; name: string; size: number; mime: string }
  | { t: 'done'; id: string }
  | { t: 'cancel'; id: string }

// ====== OCR ======

export interface OcrLine {
  text: string
  score: number
  /** 原图坐标 [x0,y0,x1,y1] */
  box: [number, number, number, number]
}

export interface OcrResult {
  lines: OcrLine[]
  fullText: string
  elapsedMs: number
}

// ====== Rust 侧返回 ======

export interface EnvInfo {
  os: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web'
  /** 默认保存目录（桌面为绝对路径；Android 为 content:// 常量标记） */
  defaultDir: string
  defaultDisplay: string
}

export interface PickedDir {
  uri: string
  display: string
}

export interface SavedFile {
  uri: string
  display: string
}

export type ExportFormat = 'txt' | 'docx' | 'pdf' | 'csv'
