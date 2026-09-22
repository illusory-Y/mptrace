// 配对二维码：内容为私有协议 JSON，也兼容直接写 6 位数字
import QRCode from 'qrcode'

export interface PairQrPayload {
  t: 'pts-pair'
  v: 1
  c: string // 6 位配对码
  s?: string // 信令服务器地址（可选，朋友私有部署时随码携带）
}

export async function makePairQr(code: string, signalUrl?: string): Promise<string> {
  const payload: PairQrPayload = { t: 'pts-pair', v: 1, c: code }
  if (signalUrl) payload.s = signalUrl
  return QRCode.toDataURL(JSON.stringify(payload), {
    margin: 1,
    width: 340,
    errorCorrectionLevel: 'M',
  })
}

export function parsePairQr(text: string): { code: string; server?: string } | null {
  const t = text.trim()
  if (/^\d{6}$/.test(t)) return { code: t }
  try {
    const j = JSON.parse(t) as Partial<PairQrPayload>
    if (j.t === 'pts-pair' && typeof j.c === 'string' && /^\d{6}$/.test(j.c)) {
      return { code: j.c, server: j.s }
    }
  } catch {
    /* 非本协议二维码 */
  }
  return null
}
