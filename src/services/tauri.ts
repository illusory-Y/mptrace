// Tauri 环境桥：所有与 Rust 侧的交互集中在这里；浏览器 `npm run dev` 时自动降级为网页能力
import { invoke } from '@tauri-apps/api/core'
import type { EnvInfo, PickedDir } from '../types'

/** 是否运行在 Tauri 壳内（Windows exe / Android APK），否则为纯浏览器调试 */
export const isTauri: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function fetchEnvInfo(): Promise<EnvInfo> {
  if (!isTauri) {
    return {
      os: 'web',
      defaultDir: '<browser-downloads>',
      defaultDisplay: '浏览器默认下载目录（网页调试模式，安装版会使用真实目录）',
    }
  }
  return invoke<EnvInfo>('env_info')
}

/** 弹出系统目录选择器。桌面为普通文件夹；Android 为 SAF（ACTION_OPEN_DOCUMENT_TREE），无需所有文件权限 */
export async function pickDirectory(): Promise<PickedDir | null> {
  if (!isTauri) return null
  const picked = await invoke<PickedDir | null>('pick_directory')
  return picked ?? null
}
