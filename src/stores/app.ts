// 全局设置：首次引导状态、保存目录、主题、字体大小、信令地址；localStorage 持久化
import { defineStore } from 'pinia'
import { isTauri } from '../services/tauri'
import type { DeviceInfo, EnvInfo, PickedDir, RecentPeer } from '../types'

const STORAGE_KEY = 'lts-settings-v1'

type Theme = 'light' | 'dark'
type FontScale = 'sm' | 'md' | 'lg' | 'xl'

interface AppState {
  onboarded: boolean
  theme: Theme
  fontScale: FontScale
  /** true=系统默认下载目录；false=用户自定义目录 */
  useDefaultDir: boolean
  defaultDir: string
  defaultDisplay: string
  /** 当前运行平台，用于 Android 专属存储策略 */
  platform: EnvInfo['os']
  /** Android 公共 Download 下的自定义子目录 */
  androidDownloadSubdir: string
  saveDirUri: string
  saveDirDisplay: string
  signalUrl: string
  stunUrl: string
  /** 本机持久设备身份（用于一键重连） */
  deviceId: string
  deviceName: string
  deviceKind: 'computer' | 'phone'
  /** 最近连接的设备（最多 5 个） */
  recentPeers: RecentPeer[]
}

function detectDeviceKind(): 'computer' | 'phone' {
  if (typeof navigator !== 'undefined' && /android|iphone|ipad|mobile/i.test(navigator.userAgent)) {
    return 'phone'
  }
  return 'computer'
}

function genDeviceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* ignore */
  }
  return 'd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function loadPersisted(): Partial<AppState> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

/** Android 只允许在公共 Download 下配置子目录，避免保存到不可访问的伪路径。 */
function normalizeAndroidDownloadSubdir(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .slice(0, 120)
}

function normalizePeerKind(kind: unknown): DeviceInfo['kind'] {
  return kind === 'computer' || kind === 'phone' ? kind : 'unknown'
}

function normalizePeerName(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLocaleLowerCase().replace(/\s+/g, ' ') : ''
}

/**
 * deviceId 是首选身份；当旧记录来自重新安装、清理站点数据或不同客户端时，
 * 用设备名称和类型把同一台机器的历史身份合并起来。
 */
function samePeer(a: DeviceInfo, b: DeviceInfo): boolean {
  if (a.deviceId && b.deviceId && a.deviceId === b.deviceId) return true

  const nameA = normalizePeerName(a.name)
  const nameB = normalizePeerName(b.name)
  if (!nameA || nameA !== nameB) return false

  const kindA = normalizePeerKind(a.kind)
  const kindB = normalizePeerKind(b.kind)
  return kindA === kindB || kindA === 'unknown' || kindB === 'unknown'
}

function dedupeRecentPeers(peers: unknown[]): RecentPeer[] {
  const normalized = peers
    .filter((peer): peer is Record<string, unknown> => !!peer && typeof peer === 'object')
    .map((peer): RecentPeer => ({
      deviceId: typeof peer.deviceId === 'string' ? peer.deviceId : '',
      name: typeof peer.name === 'string' && peer.name.trim() ? peer.name.trim() : '未命名设备',
      kind: normalizePeerKind(peer.kind),
      lastConnectedAt:
        typeof peer.lastConnectedAt === 'number' && Number.isFinite(peer.lastConnectedAt)
          ? peer.lastConnectedAt
          : 0,
    }))
    .filter((peer) => peer.deviceId)
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)

  const unique: RecentPeer[] = []
  for (const peer of normalized) {
    if (!unique.some((existing) => samePeer(existing, peer))) unique.push(peer)
  }
  return unique.slice(0, 5)
}

/** 信令地址默认值：Tauri 用 .env；浏览器模式默认与当前网页同源（部署到公网时自动跟随 https/wss） */
function defaultSignalUrl(): string {
  const envSignal = import.meta.env.VITE_SIGNAL_URL ?? ''
  if (isTauri) return envSignal
  if (envSignal) return envSignal
  if (typeof location !== 'undefined' && location.host) {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProto}//${location.host}/ws`
  }
  return 'ws://localhost:8787/ws'
}

export const useAppStore = defineStore('app', {
  state: (): AppState => {
    const persisted = loadPersisted()
    const kind =
      persisted.deviceKind === 'phone' || persisted.deviceKind === 'computer'
        ? persisted.deviceKind
        : detectDeviceKind()
    return {
      onboarded: false,
      theme: 'light',
      fontScale: 'md',
      useDefaultDir: true,
      defaultDir: '',
      defaultDisplay: '',
      saveDirUri: '',
      saveDirDisplay: '',
      ...persisted,
      platform: 'web',
      androidDownloadSubdir: normalizeAndroidDownloadSubdir(persisted.androidDownloadSubdir || ''),
      // 持久化里的空信令/STUN 地址不覆盖默认值
      signalUrl: persisted.signalUrl || defaultSignalUrl(),
      stunUrl:
        persisted.stunUrl ||
        import.meta.env.VITE_STUN_URL ||
        'stun:stun.l.google.com:19302',
      // 设备身份
      deviceId: persisted.deviceId || genDeviceId(),
      deviceKind: kind,
      deviceName: persisted.deviceName || (kind === 'phone' ? '我的手机' : '我的电脑'),
      recentPeers: dedupeRecentPeers(persisted.recentPeers ?? []),
    }
  },
  getters: {
    /** 所有文件写入唯一使用的目录标识（桌面路径 / Android content URI） */
    effectiveDir(state): string {
      if (!state.useDefaultDir) return state.saveDirUri
      if (state.platform === 'android' && state.androidDownloadSubdir) {
        return `android-downloads://${encodeURIComponent(state.androidDownloadSubdir)}`
      }
      return state.defaultDir
    },
    effectiveDirDisplay(state): string {
      if (!state.useDefaultDir) return state.saveDirDisplay
      if (state.platform === 'android' && state.androidDownloadSubdir) {
        return `公共下载目录 / Download/${state.androidDownloadSubdir}`
      }
      return state.defaultDisplay
    },
  },
  actions: {
    persist() {
      const data: AppState = {
        onboarded: this.onboarded,
        theme: this.theme,
        fontScale: this.fontScale,
        useDefaultDir: this.useDefaultDir,
        defaultDir: this.defaultDir,
        defaultDisplay: this.defaultDisplay,
        platform: this.platform,
        androidDownloadSubdir: this.androidDownloadSubdir,
        saveDirUri: this.saveDirUri,
        saveDirDisplay: this.saveDirDisplay,
        signalUrl: this.signalUrl,
        stunUrl: this.stunUrl,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        deviceKind: this.deviceKind,
        recentPeers: this.recentPeers,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    },
    applyLook() {
      document.documentElement.dataset.theme = this.theme
      document.documentElement.dataset.font = this.fontScale
    },
    setEnvInfo(info: EnvInfo) {
      this.platform = info.os
      // 仅在首次获取时写入默认目录
      if (!this.defaultDir) {
        this.defaultDir = info.defaultDir
        this.defaultDisplay = info.defaultDisplay
        this.persist()
      }
    },
    setTheme(t: Theme) {
      this.theme = t
      this.applyLook()
      this.persist()
    },
    setFontScale(f: FontScale) {
      this.fontScale = f
      this.applyLook()
      this.persist()
    },
    async chooseCustomDir(): Promise<boolean> {
      const { pickDirectory } = await import('../services/tauri')
      const picked: PickedDir | null = await pickDirectory()
      if (!picked) return false
      this.useDefaultDir = false
      this.saveDirUri = picked.uri
      this.saveDirDisplay = picked.display
      this.persist()
      return true
    },
    backToDefault() {
      this.useDefaultDir = true
      this.persist()
    },
    setAndroidDownloadSubdir(value: string) {
      this.androidDownloadSubdir = normalizeAndroidDownloadSubdir(value)
      this.useDefaultDir = true
      this.persist()
    },
    finishOnboarding() {
      this.onboarded = true
      this.persist()
    },
    /** 设置页重新走一遍引导 */
    restartOnboarding() {
      this.onboarded = false
      this.persist()
    },
    setSignalUrl(url: string) {
      this.signalUrl = url.trim()
      this.persist()
    },
    setDeviceName(name: string) {
      this.deviceName = name.trim() || (this.deviceKind === 'phone' ? '我的手机' : '我的电脑')
      this.persist()
    },
    /** 配对成功后记住对方设备（去重、最多 5 个、按时间倒序） */
    addRecentPeer(info: DeviceInfo) {
      if (!info.deviceId) return
      const entry: RecentPeer = {
        deviceId: info.deviceId,
        name: info.name?.trim() || '未命名设备',
        kind: normalizePeerKind(info.kind),
        lastConnectedAt: Date.now(),
      }
      const others = this.recentPeers.filter((p) => !samePeer(p, entry))
      this.recentPeers = [entry, ...others].slice(0, 5)
      this.persist()
    },
    removeRecentPeer(deviceId: string) {
      this.recentPeers = this.recentPeers.filter((p) => p.deviceId !== deviceId)
      this.persist()
    },
    clearRecentPeers() {
      this.recentPeers = []
      this.persist()
    },
  },
})
