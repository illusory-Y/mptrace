// ============================================================
// 私传助手 · 信令服务（Node.js + ws）
// 职责边界：只做"配对码房间"和 SDP/ICE 的透传
// 明确不做：不接触、不缓存、不记录任何文件内容（文件走 WebRTC P2P/TURN）
// ============================================================
import { createServer } from 'node:http'
import { randomInt } from 'node:crypto'
import { existsSync, statSync, createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { config as loadEnv } from 'dotenv'

loadEnv()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 托管的前端静态目录：默认仓库根的 dist，可用 DIST_DIR 覆盖
const DIST_DIR = path.resolve(process.env.DIST_DIR || path.join(__dirname, '..', 'dist'))

const PORT = Number(process.env.PORT || 8787)
const WS_PATH = process.env.WS_PATH || '/ws'
const CODE_TTL_MS = Number(process.env.CODE_TTL_MS || 5 * 60_000)
const TRUST_PROXY = process.env.TRUST_PROXY === 'true'
const STUN_URL = process.env.STUN_URL || 'stun:stun.l.google.com:19302'
const TURN_URL = process.env.TURN_URL || ''
const TURN_USERNAME = process.env.TURN_USERNAME || ''
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || ''

// 简单建房间限流：同一 IP 10 秒最多 12 次
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 12
const createHits = new Map()

function buildIceServers() {
  const servers = []
  const stun = STUN_URL.split(',').map((s) => s.trim()).filter(Boolean)
  if (stun.length) servers.push({ urls: stun })
  const turn = TURN_URL.split(',').map((s) => s.trim()).filter(Boolean)
  if (turn.length && TURN_USERNAME && TURN_CREDENTIAL) {
    servers.push({ urls: turn, username: TURN_USERNAME, credential: TURN_CREDENTIAL })
  }
  return servers
}
const ICE_SERVERS = buildIceServers()

/** @type {Map<string, {code:string, hostId:string, guestId:string|null, createdAt:number, timer:NodeJS.Timeout}>} */
const rooms = new Map()
/** @type {Map<string, {ws:WebSocket, roomCode:string|null, role:'host'|'guest'|null, ip:string}>} */
const peers = new Map()
let idSeq = 1

function genCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    if (!rooms.has(code)) return code
  }
  throw new Error('配对码空间繁忙')
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

function sendTo(peerId, obj) {
  const p = peers.get(peerId)
  if (p) send(p.ws, obj)
}

function rateLimited(ip) {
  const now = Date.now()
  const arr = (createHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS)
  arr.push(now)
  createHits.set(ip, arr)
  return arr.length > RATE_MAX
}

function leaveRoom(peerId, notifyPeer = true) {
  for (const [code, room] of rooms) {
    if (room.hostId === peerId) {
      clearTimeout(room.timer)
      rooms.delete(code)
      if (notifyPeer && room.guestId) sendTo(room.guestId, { type: 'peer-left' })
      return
    }
    if (room.guestId === peerId) {
      room.guestId = null
      if (notifyPeer) sendTo(room.hostId, { type: 'peer-left' })
      return
    }
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 跨源隔离头：多线程 WASM（OCR）需要，与 vite dev 保持一致 */
function setIsolationHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
}

/** 托管前端静态资源，找不到时回退 index.html（SPA） */
function serveStatic(req, res) {
  setIsolationHeaders(res)
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
  } catch {
    res.writeHead(400)
    return res.end('bad request')
  }
  if (pathname === '/') pathname = '/index.html'

  let filePath = path.normalize(path.join(DIST_DIR, pathname))
  // 防路径穿越
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403)
    return res.end('forbidden')
  }

  try {
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
    if (!existsSync(filePath)) {
      filePath = path.join(DIST_DIR, 'index.html') // SPA fallback
    }
    if (!existsSync(filePath)) {
      res.writeHead(404)
      return res.end('not found')
    }
    const stat = statSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // hash 资源长缓存，HTML 不缓存
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    createReadStream(filePath).pipe(res)
  } catch {
    res.writeHead(500)
    res.end('server error')
  }
}

const httpServer = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers: peers.size }))
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res)
  res.writeHead(404)
  res.end('not found')
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  if (pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws, req) => {
  const peerId = String(idSeq++)
  const ip = TRUST_PROXY
    ? (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '')
    : req.socket.remoteAddress || ''
  peers.set(peerId, { ws, roomCode: null, role: null, ip })
  console.log(`[peer ${peerId}] connected from ${ip}`)

  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return send(ws, { type: 'error', message: '非法消息' })
    }
    const peer = peers.get(peerId)
    if (!peer) return

    switch (msg.type) {
      case 'hello': {
        // 下发 ICE 配置（含私有 TURN 凭据）与配对码有效期
        send(ws, { type: 'config', iceServers: ICE_SERVERS, ttlMs: CODE_TTL_MS })
        break
      }

      case 'create': {
        if (rateLimited(ip)) {
          return send(ws, { type: 'error', message: '操作过于频繁，请稍后再试' })
        }
        // 同一连接重复创建：先释放旧房间
        leaveRoom(peerId, false)
        const code = genCode()
        const timer = setTimeout(() => {
          const room = rooms.get(code)
          if (!room) return
          rooms.delete(code)
          sendTo(room.hostId, { type: 'expired' })
          if (room.guestId) sendTo(room.guestId, { type: 'expired' })
          console.log(`[room ${code}] expired`)
        }, CODE_TTL_MS)
        rooms.set(code, {
          code,
          hostId: peerId,
          guestId: null,
          createdAt: Date.now(),
          timer,
        })
        peer.roomCode = code
        peer.role = 'host'
        send(ws, { type: 'created', code, expiresAt: Date.now() + CODE_TTL_MS })
        console.log(`[room ${code}] created by ${peerId}`)
        break
      }

      case 'join': {
        const code = String(msg.code || '')
        const room = rooms.get(code)
        if (!room) return send(ws, { type: 'error', message: '配对码不存在或已失效' })
        if (room.guestId && room.guestId !== peerId) {
          return send(ws, { type: 'error', message: '该配对码已被使用' })
        }
        if (room.hostId === peerId) {
          return send(ws, { type: 'error', message: '不能与自己配对' })
        }
        // 该连接若残留在其他房间，先静默退出
        leaveRoom(peerId, false)
        room.guestId = peerId
        peer.roomCode = code
        peer.role = 'guest'
        send(ws, { type: 'joined' })
        sendTo(room.hostId, { type: 'peer-join', peerId })
        console.log(`[room ${code}] guest ${peerId} joined`)
        break
      }

      // 以下三类只在房间两端之间透传，服务端不解析、不落盘
      case 'offer':
      case 'answer':
      case 'candidate': {
        if (!peer.roomCode) return
        const room = rooms.get(peer.roomCode)
        if (!room) return
        const target = peer.role === 'host' ? room.guestId : room.hostId
        if (target) sendTo(target, msg)
        break
      }

      case 'leave': {
        leaveRoom(peerId, true)
        peer.roomCode = null
        peer.role = null
        break
      }

      default:
        send(ws, { type: 'error', message: '未知消息类型' })
    }
  })

  ws.on('close', () => {
    leaveRoom(peerId, true)
    peers.delete(peerId)
    console.log(`[peer ${peerId}] closed`)
  })

  ws.on('error', () => {
    /* 单连接错误不影响进程 */
  })
})

// 心跳：30s 一次 ping，连续两次无 pong 断开
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate()
    ws.isAlive = false
    ws.ping()
  })
  // 顺带清理限流内存
  const now = Date.now()
  for (const [ip, arr] of createHits) {
    const valid = arr.filter((t) => now - t < RATE_WINDOW_MS)
    if (valid.length) createHits.set(ip, valid)
    else createHits.delete(ip)
  }
}, 30_000)

wss.on('close', () => clearInterval(heartbeat))

httpServer.listen(PORT, () => {
  console.log(`信令服务已启动: ws://0.0.0.0:${PORT}${WS_PATH}`)
  console.log(`健康检查: http://0.0.0.0:${PORT}/health`)
  console.log(`配对码有效期: ${CODE_TTL_MS / 1000}s；TURN ${TURN_URL ? '已配置' : '未配置（仅 STUN，极端对称 NAT 可能无法连通）'}`)
})
