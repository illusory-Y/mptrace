// 全局设置：首次引导状态、保存目录、主题、字体大小、信令地址；localStorage 持久化
import { defineStore } from 'pinia'
import { isTauri } from '../services/tauri'
import type { EnvInfo, PickedDir } from '../types'

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
  saveDirUri: string
  saveDirDisplay: string
  signalUrl: string
  stunUrl: string
}

function loadPersisted(): Partial<AppState> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
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
      // 持久化里的空信令/STUN 地址不覆盖默认值
      signalUrl: persisted.signalUrl || defaultSignalUrl(),
      stunUrl:
        persisted.stunUrl ||
        import.meta.env.VITE_STUN_URL ||
        'stun:stun.l.google.com:19302',
    }
  },
  getters: {
    /** 所有文件写入唯一使用的目录标识（桌面路径 / Android content URI） */
    effectiveDir(state): string {
      return state.useDefaultDir ? state.defaultDir : state.saveDirUri
    },
    effectiveDirDisplay(state): string {
      return state.useDefaultDir ? state.defaultDisplay : state.saveDirDisplay
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
        saveDirUri: this.saveDirUri,
        saveDirDisplay: this.saveDirDisplay,
        signalUrl: this.signalUrl,
        stunUrl: this.stunUrl,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    },
    applyLook() {
      document.documentElement.dataset.theme = this.theme
      document.documentElement.dataset.font = this.fontScale
    },
    setEnvInfo(info: EnvInfo) {
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
  },
})
