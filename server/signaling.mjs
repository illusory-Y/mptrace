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
const TURN_URL = process.env.TURN_URL || ''
const TURN_USERNAME = process.env.TURN_USERNAME || ''
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || ''

// 默认 STUN：Cloudflare（免费全球）+ 国内节点 + Google 兜底；
// 显式设置 STUN_URL 时以其为准。
const DEFAULT_STUN = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.qq.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.l.google.com:19302',
]
const STUN_LIST = (process.env.STUN_URL ? process.env.STUN_URL.split(',') : DEFAULT_STUN)
  .map((s) => s.trim())
  .filter(Boolean)

// 静态 TURN（环境变量显式配置时优先，且不再动态获取）
const STATIC_TURN_URLS = TURN_URL.split(',').map((s) => s.trim()).filter(Boolean)
const useStaticTurn = STATIC_TURN_URLS.length && TURN_USERNAME && TURN_CREDENTIAL

// 动态 TURN：从 Cloudflare 公开（免费、无需账号）端点获取短期凭据并缓存。
// 服务器在海外，固定出口 IP 低频拉取不会触发限流；失败则沿用上次凭据。
const TURN_CREDS_URL = process.env.TURN_CREDS_URL || 'https://speed.cloudflare.com/turn-creds'
const TURN_REFRESH_MS = Number(process.env.TURN_REFRESH_MS || 3 * 3600 * 1000)
/** @type {{urls:string[], username:string, credential:string, fetchedAt:number}|null} */
let dynamicTurn = null
let turnFetching = null

async function fetchDynamicTurn() {
  if (useStaticTurn) return
  if (turnFetching) return turnFetching
  turnFetching = (async () => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const r = await fetch(TURN_CREDS_URL, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const d = await r.json()
      if (!d || !d.username || !d.credential || !Array.isArray(d.urls)) {
        throw new Error('凭据响应不完整')
      }
      const urls = d.urls.filter((u) => u.startsWith('turn'))
      dynamicTurn = { urls, username: d.username, credential: d.credential, fetchedAt: Date.now() }
      console.log('[turn] 动态凭据已刷新，中继', urls.length, '条')
    } catch (e) {
      console.warn('[turn] 动态凭据获取失败：' + e.message + (dynamicTurn ? '（沿用旧凭据）' : '（当前无中继）'))
    } finally {
      turnFetching = null
    }
  })()
  return turnFetching
}

// 简单建房间限流：同一 IP 10 秒最多 12 次
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 12
const createHits = new Map()

function buildIceServers() {
  const servers = []
  if (STUN_LIST.length) servers.push({ urls: STUN_LIST })
  if (useStaticTurn) {
    servers.push({ urls: STATIC_TURN_URLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL })
  } else if (dynamicTurn && dynamicTurn.urls.length) {
    servers.push({
      urls: dynamicTurn.urls,
      username: dynamicTurn.username,
      credential: dynamicTurn.credential,
    })
  }
  return servers
}

/** @type {Map<string, {code:string, hostId:string, guestId:string|null, createdAt:number, timer:NodeJS.Timeout}>} */
const rooms = new Map()
/** @type {Map<string, {ws:WebSocket, roomCode:string|null, role:'host'|'guest'|null, ip:string, deviceId:string, name:string, kind:string, pendingCall:string|null}>} */
const peers = new Map()
/** 在线设备：deviceId -> peerId（用于一键重连） */
const devices = new Map()
/** 待接呼叫：callId -> {callerId:string, calleeId:string, timer:NodeJS.Timeout} */
const pendingCalls = new Map()
let idSeq = 1

function deviceInfo(peerId) {
  const p = peers.get(peerId)
  if (!p || !p.deviceId) return null
  return { deviceId: p.deviceId, name: p.name || '未命名设备', kind: p.kind || 'unknown' }
}

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
  peers.set(peerId, {
    ws,
    roomCode: null,
    role: null,
    ip,
    deviceId: '',
    name: '',
    kind: 'unknown',
    pendingCall: null,
  })
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
        // 注册持久设备身份（用于一键重连）
        peer.deviceId = String(msg.deviceId || '')
        peer.name = String(msg.name || '未知设备')
        peer.kind = String(msg.kind || 'unknown')
        if (peer.deviceId) devices.set(peer.deviceId, peerId)
        // 下发 ICE 配置（含动态 TURN 凭据）与配对码有效期
        send(ws, { type: 'config', iceServers: buildIceServers(), ttlMs: CODE_TTL_MS })
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
        send(ws, { type: 'joined', peer: deviceInfo(room.hostId) || undefined })
        sendTo(room.hostId, { type: 'peer-join', peerId, peer: deviceInfo(peerId) || undefined })
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

      // ---- 设备到设备一键重连 ----
      case 'call': {
        const targetDevice = String(msg.target || '')
        const calleeId = devices.get(targetDevice)
        if (!calleeId) {
          return send(ws, {
            type: 'error',
            message: '对方当前不在线，无法自动重连（请改用扫码或配对码）',
          })
        }
        if (calleeId === peerId) {
          return send(ws, { type: 'error', message: '不能呼叫自己' })
        }
        // 清理本连接之前未完成的呼叫
        for (const [id, c] of pendingCalls) {
          if (c.callerId === peerId || c.calleeId === peerId) {
            clearTimeout(c.timer)
            pendingCalls.delete(id)
            const other = c.callerId === peerId ? c.calleeId : c.callerId
            const op = peers.get(other)
            if (op) op.pendingCall = null
          }
        }
        const callId = 'c' + randomInt(1e8, 1e10).toString(36)
        const timer = setTimeout(() => {
          if (!pendingCalls.has(callId)) return
          pendingCalls.delete(callId)
          const op = peers.get(calleeId)
          if (op) op.pendingCall = null
          peer.pendingCall = null
          sendTo(peerId, { type: 'error', message: '对方暂无应答，请稍后再试或改用扫码' })
        }, 60_000)
        pendingCalls.set(callId, { callerId: peerId, calleeId, timer })
        peer.pendingCall = callId
        const callee = peers.get(calleeId)
        if (callee) callee.pendingCall = callId
        const from =
          deviceInfo(peerId) || {
            deviceId: '',
            name: peer.name || '未知设备',
            kind: peer.kind || 'unknown',
          }
        sendTo(calleeId, { type: 'incoming-call', callId, from })
        console.log(`[call ${callId}] ${peerId} -> ${calleeId}`)
        break
      }

      case 'call-accept': {
        const callId = String(msg.callId || '')
        const c = pendingCalls.get(callId)
        if (!c) return send(ws, { type: 'error', message: '呼叫已失效，请重新发起' })
        if (c.calleeId !== peerId) return
        clearTimeout(c.timer)
        // 双方先静默退出旧房间
        leaveRoom(c.callerId, false)
        leaveRoom(c.calleeId, false)
        const roomTimer = setTimeout(() => {
          if (!rooms.has(callId)) return
          rooms.delete(callId)
          sendTo(c.callerId, { type: 'expired' })
          sendTo(c.calleeId, { type: 'expired' })
        }, CODE_TTL_MS)
        // 正式房间：host=callee（建数据通道/发 offer），guest=caller（回 answer）
        rooms.set(callId, {
          code: callId,
          hostId: c.calleeId,
          guestId: c.callerId,
          createdAt: Date.now(),
          timer: roomTimer,
        })
        const calleeP = peers.get(c.calleeId)
        calleeP.roomCode = callId
        calleeP.role = 'host'
        calleeP.pendingCall = null
        const callerP = peers.get(c.callerId)
        callerP.roomCode = callId
        callerP.role = 'guest'
        callerP.pendingCall = null
        pendingCalls.delete(callId)
        sendTo(c.callerId, { type: 'call-connected', callId })
        send(ws, { type: 'call-accepted', callId })
        console.log(`[call ${callId}] accepted; host=${c.calleeId} guest=${c.callerId}`)
        break
      }

      case 'call-reject': {
        const callId = String(msg.callId || '')
        const c = pendingCalls.get(callId)
        if (!c) break
        clearTimeout(c.timer)
        pendingCalls.delete(callId)
        const cp = peers.get(c.callerId)
        if (cp) cp.pendingCall = null
        peer.pendingCall = null
        sendTo(c.callerId, { type: 'call-rejected' })
        break
      }

      default:
        send(ws, { type: 'error', message: '未知消息类型' })
    }
  })

  ws.on('close', () => {
    // 注销在线设备
    if (peer.deviceId && devices.get(peer.deviceId) === peerId) {
      devices.delete(peer.deviceId)
    }
    // 清理待接呼叫：作为被呼叫方离开则通知呼叫方，作为呼叫方离开则静默取消
    if (peer.pendingCall) {
      const c = pendingCalls.get(peer.pendingCall)
      if (c) {
        clearTimeout(c.timer)
        pendingCalls.delete(peer.pendingCall)
        if (c.calleeId === peerId) {
          const callerP = peers.get(c.callerId)
          if (callerP) callerP.pendingCall = null
          sendTo(c.callerId, { type: 'call-rejected' })
        } else {
          const calleeP = peers.get(c.calleeId)
          if (calleeP) calleeP.pendingCall = null
        }
      }
    }
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

async function start() {
  // 启动前先取一次中继凭据（内部已容错，失败不阻塞启动）
  await fetchDynamicTurn()
  httpServer.listen(PORT, () => {
    console.log(`信令服务已启动: ws://0.0.0.0:${PORT}${WS_PATH}`)
    console.log(`健康检查: http://0.0.0.0:${PORT}/health`)
    console.log(
      `配对码有效期: ${CODE_TTL_MS / 1000}s；TURN ${
        useStaticTurn ? '静态已配置' : dynamicTurn ? '动态已就绪' : '暂未就绪（将继续重试）'
      }`,
    )
  })
  // 每小时检查，超过刷新周期则重新获取
  setInterval(() => {
    if (useStaticTurn) return
    const age = dynamicTurn ? Date.now() - dynamicTurn.fetchedAt : Infinity
    if (age >= TURN_REFRESH_MS) void fetchDynamicTurn()
  }, 60 * 60 * 1000)
}

void start()
