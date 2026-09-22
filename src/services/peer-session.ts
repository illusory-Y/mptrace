// ============================================================
// 互传会话单例桥：互传页创建 TransferPeer 后登记到这里，
// 其他页面（如 OCR 识别页）可把导出的文档直接发给已连接对端。
// 纯内存引用，不持久化、不复制数据。
// ============================================================
import type { TransferPeer } from './webrtc'

let activePeer: TransferPeer | null = null

export function setActivePeer(peer: TransferPeer | null): void {
  activePeer = peer
}

export function getActivePeer(): TransferPeer | null {
  return activePeer
}

export function isPeerConnected(): boolean {
  return activePeer?.isChannelOpen === true
}

/** 把内存中的字节包装成 File 并入队发送 */
export async function sendBytesToPeer(
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  if (!activePeer || !activePeer.isChannelOpen) {
    throw new Error('当前没有已连接的对端：请先到「互传」页完成配对连接')
  }
  const file = new File([bytes as BlobPart], name, { type: mime })
  await activePeer.enqueueFiles([file])
}
