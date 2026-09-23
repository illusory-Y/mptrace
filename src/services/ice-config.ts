// ============================================================
// ICE（NAT 穿透）默认配置
// - STUN：发现公网映射地址，含国内可达节点，免费
// - TURN：直连失败时的中继兜底（对称 NAT / 严格网络必需）
//
// 说明：当前 TURN 凭据为 Cloudflare 免费演示端点签发的【临时凭据】，
// 仅用于验证跨网连通性，会过期。验证通过后将改为由信令服务器用
// Cloudflare TURN key 动态签发并通过 config 消息下发（长期稳定）。
// ============================================================

/** 公共 STUN（Cloudflare 免费无限 + 国内节点 + Google 海外兜底） */
export const FALLBACK_STUN: string[] = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.qq.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.l.google.com:19302',
]

/**
 * 临时 TURN 凭据（Cloudflare 免费 TURN，1TB/月免费额度）。
 * 端口 3478（UDP/TCP）与 5349（TLS，最容易穿透严格防火墙）。
 */
export const FALLBACK_TURN: RTCIceServer = {
  urls: [
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turn:turn.cloudflare.com:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp',
  ],
  username: 'g0f60c39c7ceef7584424538cbb00e8730d48620b3974155f919998b0c7fcd20',
  credential: '4b3aff0c8cccfda302f9c6c17a60d329527706fee76344c3e7f06c5a92653908',
}

/** 客户端默认 ICE 列表（STUN + 临时 TURN） */
export function buildDefaultIce(): RTCIceServer[] {
  return [{ urls: FALLBACK_STUN }, FALLBACK_TURN]
}
