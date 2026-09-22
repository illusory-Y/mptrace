// ============================================================
// 统一文件保存出口：OCR 导出、互传接收，全部经此模块写入用户配置目录
// Tauri 下走 Rust 命令（桌面 std::fs / Android SAF + MediaStore）
// 浏览器调试下降级为普通下载，保证 npm run dev 也能完整体验界面
// ============================================================
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './tauri'
import type { SavedFile } from '../types'

/** 时间戳 + 原文件名，避免重名覆盖（Rust 侧还会再做一次冲突兜底） */
export function timestampName(original: string): string {
  const d = new Date()
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}`
  const safe = original.trim().replace(/[\\/:*?"<>| -]/g, '_') || 'unnamed'
  return `${stamp}_${safe}`
}

/** 分片 base64，避免大参数展开触碰 JS 引擎参数上限 */
export function bytesToBase64(u8: Uint8Array): string {
  const CHUNK = 0x2000 // 8192
  let bin = ''
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '-'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec) return '0 KB/s'
  return `${formatBytes(bytesPerSec)}/s`
}

export async function fileToBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }))
}

function browserDownload(name: string, bytes: Uint8Array, mime: string): SavedFile {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { uri: url, display: `浏览器下载：${name}（网页调试模式）` }
}

/** 小文件一次性保存（OCR 导出文本类文件用） */
export async function saveSmallFile(
  dir: string,
  name: string,
  bytes: Uint8Array,
  mime = 'application/octet-stream',
): Promise<SavedFile> {
  if (!isTauri) return browserDownload(name, bytes, mime)
  const b64 = bytesToBase64(bytes)
  return invoke<SavedFile>('save_small_file', { dir, name, mime, b64 })
}

/** 大文件流式写入器（互传接收边收边落盘，不把整个文件堆在内存） */
export interface ReceivedWriter {
  create(dir: string, name: string, mime: string): Promise<void>
  append(chunk: Uint8Array): Promise<void>
  finish(): Promise<SavedFile>
  cancel(): Promise<void>
}

const APPEND_CHUNK = 512 * 1024 // IPC base64 分片，单包 512KB

class TauriReceivedWriter implements ReceivedWriter {
  private sessionId = 0
  async create(dir: string, name: string, mime: string) {
    this.sessionId = await invoke<number>('create_write_session', { dir, name, mime })
  }
  async append(chunk: Uint8Array) {
    for (let i = 0; i < chunk.length; i += APPEND_CHUNK) {
      const b64 = bytesToBase64(chunk.subarray(i, i + APPEND_CHUNK))
      await invoke('append_write_session', { id: this.sessionId, b64 })
    }
  }
  async finish() {
    return invoke<SavedFile>('finish_write_session', { id: this.sessionId })
  }
  async cancel() {
    if (this.sessionId) await invoke('cancel_write_session', { id: this.sessionId }).catch(() => {})
  }
}

class BrowserReceivedWriter implements ReceivedWriter {
  private parts: Uint8Array[] = []
  private name = ''
  private mime = 'application/octet-stream'
  async create(_dir: string, name: string, mime: string) {
    this.parts = []
    this.name = name
    this.mime = mime
  }
  async append(chunk: Uint8Array) {
    this.parts.push(chunk)
  }
  async finish() {
    const total = this.parts.reduce((s, p) => s + p.length, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const p of this.parts) {
      merged.set(p, off)
      off += p.length
    }
    return browserDownload(this.name, merged, this.mime)
  }
  async cancel() {}
}

export function createReceivedWriter(): ReceivedWriter {
  return isTauri ? new TauriReceivedWriter() : new BrowserReceivedWriter()
}
