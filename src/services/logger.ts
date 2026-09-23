// ============================================================
// 轻量运行日志：环形缓冲 + localStorage 持久化
// 用途：记录信令 / WebRTC / 文件收发的关键过程，连接异常时可一键复制，
// 便于在没有真机调试环境下定位问题。
// ============================================================

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface LogEntry {
  ts: number
  level: LogLevel
  tag: string
  msg: string
}

const MAX_LIVE = 600 // 内存最多保留条数
const MAX_PERSIST = 400 // 写入 localStorage 的最多条数
const STORAGE_KEY = 'mptrace_runtime_logs'

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
}

/** 低于该级别的日志不记录（发布版默认 DEBUG 全收，方便排障） */
let minLevel: LogLevel = 'DEBUG'

function safeParse(raw: string): LogEntry[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

class AppLogger {
  private entries: LogEntry[] = []

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) this.entries = safeParse(raw).slice(-MAX_LIVE)
    } catch {
      /* 隐私模式等场景忽略 */
    }
  }

  setMinLevel(level: LogLevel) {
    minLevel = level
  }

  log(level: LogLevel, tag: string, msg: unknown) {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return
    const text =
      msg instanceof Error ? msg.message : typeof msg === 'object' ? safeStringify(msg) : String(msg)
    const entry: LogEntry = { ts: Date.now(), level, tag, msg: text }
    this.entries.push(entry)
    if (this.entries.length > MAX_LIVE) {
      this.entries.splice(0, this.entries.length - MAX_LIVE)
    }
    this.persist()
    mirrorConsole(entry)
  }

  debug(tag: string, msg?: unknown) {
    this.log('DEBUG', tag, msg ?? '')
  }
  info(tag: string, msg?: unknown) {
    this.log('INFO', tag, msg ?? '')
  }
  warn(tag: string, msg?: unknown) {
    this.log('WARN', tag, msg ?? '')
  }
  error(tag: string, msg?: unknown) {
    this.log('ERROR', tag, msg ?? '')
  }

  private persist() {
    try {
      const tail = this.entries.slice(-MAX_PERSIST)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tail))
    } catch {
      /* 配额满 / 不可用时忽略 */
    }
  }

  all(): LogEntry[] {
    return this.entries.slice()
  }

  clear() {
    this.entries = []
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }

  /** 导出为可直接粘贴的纯文本，附设备/环境信息 */
  exportText(): string {
    const lines = this.entries.map((e) => `${fmtTime(e.ts)} ${e.level.padEnd(5)} [${e.tag}] ${e.msg}`)
    const header = [
      `# 私传助手 运行日志`,
      `# 导出时间: ${fmtTime(Date.now())}`,
      `# UA: ${navigator.userAgent}`,
      `# 在线状态: ${navigator.onLine ? '在线' : '离线'}`,
      `# 日志条数: ${this.entries.length}`,
      '',
    ]
    return header.concat(lines).join('\n')
  }
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj)
  } catch {
    return String(obj)
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(
    d.getSeconds(),
  )}.${p(d.getMilliseconds(), 3)}`
}

function mirrorConsole(e: LogEntry) {
  const line = `[${e.tag}] ${e.msg}`
  switch (e.level) {
    case 'ERROR':
      console.error(line)
      break
    case 'WARN':
      console.warn(line)
      break
    case 'DEBUG':
      // 调试信息也输出，便于开发时在 DevTools 查看
      console.debug(line)
      break
    default:
      console.log(line)
  }
}

export const logger = new AppLogger()
