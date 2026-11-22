/**
 * EO Assistant relay server.
 *
 * Responsibilities:
 *   - QR bind handshake (desktop create -> phone claim -> 6-digit confirm);
 *   - signed REST + authenticated WebSocket transport;
 *   - encrypted-envelope fan-out and offline backlog;
 *   - online presence for both ends;
 *   - serves the mobile PWA from ./public/app.
 *
 * The relay never sees plaintext: envelopes are AES-256-GCM ciphertext
 * produced with a key derived from the two devices' X25519 keys.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { authenticateRest, authenticateWs, safeEqual, verifyEd25519 } from './auth.js'
import { RelayDb } from './db.js'
import { canonicalEnvelope, isConvId, nowMs, sha256hex } from './protocol.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
}

function envConfig(env = process.env) {
  const root = path.resolve(import.meta.dirname, '..')
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '0.0.0.0',
    dataFile: env.DATA_FILE || path.join(root, 'data', 'eo-relay.sqlite'),
    publicDir: env.PUBLIC_DIR || path.join(root, 'public'),
    maxBodyBytes: Number(env.MAX_BODY_BYTES || 1024 * 1024),
    maxBlobBytes: Number(env.MAX_BLOB_BYTES || 17 * 1024 * 1024),
    corsOrigins: env.CORS_ORIGINS || '*',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    bindTtlMs: Number(env.BIND_TTL_MS || 120_000),
  }
}

function json(res, status, body, extra = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(text)
}

function applyCors(req, res, origins) {
  const origin = req.headers.origin
  if (!origin) return
  const allow = origins === '*' ? '*' : origins.split(',').map(v => v.trim()).filter(Boolean).includes(origin) ? origin : ''
  if (!allow) return
  res.setHeader('access-control-allow-origin', allow)
  res.setHeader('vary', 'Origin')
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, x-eo-device, x-eo-ts, x-eo-sig, x-eo-ed, x-eo-x')
  res.setHeader('access-control-max-age', '600')
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return 'missing envelope'
  if (envelope.v !== 1) return 'unsupported envelope version'
  if (!isConvId(envelope.convId)) return 'invalid convId'
  if (typeof envelope.msgId !== 'string' || envelope.msgId.length < 4 || envelope.msgId.length > 80) return 'invalid msgId'
  if (!Number.isInteger(envelope.seq) || envelope.seq < 1 || envelope.seq > 1_000_000_000) return 'invalid seq'
  if (typeof envelope.kind !== 'string' || envelope.kind.length < 1 || envelope.kind.length > 32) return 'invalid kind'
  if (typeof envelope.sender !== 'string' || envelope.sender.length < 4) return 'invalid sender'
  if (!Number.isInteger(envelope.ts) || envelope.ts <= 0) return 'invalid ts'
  if (typeof envelope.nonce !== 'string' || envelope.nonce.length < 8) return 'invalid nonce'
  if (typeof envelope.ct !== 'string' || envelope.ct.length < 16) return 'invalid ciphertext'
  if (typeof envelope.sig !== 'string' || envelope.sig.length < 16) return 'invalid signature'
  if (envelope.meta != null && typeof envelope.meta !== 'object') return 'invalid meta'
  return ''
}

class RateLimiter {
  constructor() {
    this.buckets = new Map()
    this.lastSweep = 0
  }

  hit(key, limit, windowMs) {
    const now = nowMs()
    if (now - this.lastSweep > 60_000) {
      this.lastSweep = now
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey)
      }
    }
    let bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      this.buckets.set(key, bucket)
    }
    bucket.count += 1
    return bucket.count <= limit
  }
}

function serveStatic(req, res, publicDir, pathname) {
  const relative = pathname === '/app' || pathname === '/app/' ? 'app/index.html' : pathname.replace(/^\/app\//, 'app/')
  const resolved = path.resolve(publicDir, relative)
  if (!resolved.startsWith(path.resolve(publicDir) + path.sep)) {
    json(res, 403, { error: 'forbidden' })
    return true
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false
  const ext = path.extname(resolved).toLowerCase()
  const body = fs.readFileSync(resolved)
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-store' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
  }
  res.writeHead(200, headers)
  res.end(body)
  return true
}

export function createRelay(options = {}) {
  const config = { ...envConfig(), ...options }
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true, mode: 0o700 })
  const db = new RelayDb(config.dataFile)
  const blobDir = path.join(path.dirname(config.dataFile), 'blobs')
  fs.mkdirSync(blobDir, { recursive: true, mode: 0o700 })
  const sockets = new Map()
  const limiter = new RateLimiter()
  const instanceId = crypto.randomUUID()
  let closed = false

  function socketsFor(deviceId) {
    return sockets.get(deviceId) ?? new Set()
  }

  function isOnline(deviceId) {
    return socketsFor(deviceId).size > 0
  }

  function blobFile(blobId) {
    return path.join(blobDir, blobId)
  }

  /** Notify both ends that a device's display name/icon changed, without
   * shipping the icon bytes over the WebSocket. */
  function broadcastProfile(deviceId) {
    const profile = db.getProfile(deviceId)
    if (!profile) return
    for (const conv of db.conversationsFor(deviceId)) {
      const peer = db.peerOf(conv, deviceId)
      if (!peer) continue
      sendToDevice(peer.deviceId, {
        type: 'profile',
        convId: conv.conv_id,
        peerDeviceId: deviceId,
        name: profile.name,
        iconType: profile.icon_type || '',
        iconVersion: profile.updated_at,
        ts: nowMs(),
      })
    }
  }

  function sendToDevice(deviceId, frame) {
    const text = JSON.stringify(frame)
    for (const socket of socketsFor(deviceId)) {
      if (socket.readyState === 1) socket.send(text)
    }
  }

  function bindConfirmedFrame(bind, conv) {
    return {
      type: 'bind/confirmed',
      bindId: bind.bind_id,
      convId: conv.conv_id,
      peerDeviceId: conv.phone_device_id,
      peerEdPub: conv.phone_ed_pub,
      peerXPub: conv.phone_x_pub,
      seq: 0,
      ts: nowMs(),
    }
  }

  function sendPendingBindNotices(deviceId) {
    for (const bind of db.pendingBindNotices(deviceId)) {
      if (bind.status === 'claimed') {
        sendToDevice(deviceId, { type: 'bind/claimed', bindId: bind.bind_id, code: bind.code, ts: nowMs() })
      } else if (bind.status === 'confirmed') {
        const conv = db.findConversation(bind.desktop_device_id, bind.phone_device_id)
        if (conv) sendToDevice(deviceId, bindConfirmedFrame(bind, conv))
      }
    }
  }

  function announcePresence(deviceId, online) {
    for (const conv of db.conversationsFor(deviceId)) {
      const peer = db.peerOf(conv, deviceId)
      if (!peer) continue
      sendToDevice(peer.deviceId, { type: 'presence', convId: conv.conv_id, online, ts: nowMs() })
    }
  }

  function sendPeerPresenceToSelf(deviceId) {
    for (const conv of db.conversationsFor(deviceId)) {
      const peer = db.peerOf(conv, deviceId)
      if (!peer) continue
      sendToDevice(deviceId, { type: 'presence', convId: conv.conv_id, online: isOnline(peer.deviceId), ts: nowMs() })
    }
  }

  function upsertAuthenticatedDevice(auth) {
    db.upsertDevice({
      deviceId: auth.deviceId,
      edPub: auth.edPub,
      xPub: auth.xPub,
      fingerprint: auth.deviceId.slice(-8),
    })
    db.touchDevice(auth.deviceId)
  }

  function acceptEnvelope(deviceId, envelope) {
    const invalid = validateEnvelope(envelope)
    if (invalid) return { ok: false, status: 400, error: invalid }
    if (envelope.sender !== deviceId) return { ok: false, status: 403, error: 'sender must be the authenticated device' }
    const conv = db.getConversation(envelope.convId)
    if (!conv) return { ok: false, status: 404, error: 'conversation not found' }
    const peer = db.peerOf(conv, deviceId)
    if (!peer) return { ok: false, status: 403, error: 'not a conversation member' }
    // peer.role is the *sender's* role: when the peer is the desktop, this
    // socket is the phone, so verify with the phone key.
    const senderEd = peer.role === 'desktop' ? conv.phone_ed_pub : conv.desktop_ed_pub
    if (!verifyEd25519(canonicalEnvelope(envelope), Buffer.from(envelope.sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), Buffer.from(senderEd, 'base64url'))) {
      return { ok: false, status: 403, error: 'bad message signature' }
    }
    const result = db.insertMessage(conv, envelope)
    if (result.seqConflict) return { ok: false, status: 409, error: 'seq already used by this sender' }
    if (!result.duplicate) sendToDevice(peer.deviceId, { type: 'msg', envelope })
    return { ok: true, duplicate: result.duplicate, peerDeviceId: peer.deviceId }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname
    applyCors(req, res, config.corsOrigins)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }

    try {
      if (pathname === '/health' && req.method === 'GET') {
        json(res, 200, { ok: true, service: 'eo-relay', instanceId, time: nowMs() })
        return
      }

      const profileGetMatch = pathname.match(/^\/v1\/profile\/([A-Za-z0-9_-]{8,64})$/)
      if (profileGetMatch && req.method === 'GET') {
        if (!limiter.hit(`profile-get:${clientIp(req, config.trustProxy)}`, 120, 60_000)) {
          json(res, 429, { error: 'too many requests' })
          return
        }
        const profile = db.getProfile(profileGetMatch[1])
        if (!profile) { json(res, 404, { error: 'profile not found' }); return }
        json(res, 200, {
          deviceId: profile.device_id,
          name: profile.name,
          iconType: profile.icon_type || '',
          iconBase64: profile.icon ? Buffer.from(profile.icon).toString('base64') : '',
          updatedAt: profile.updated_at,
        })
        return
      }

      if (pathname === '/v1/profile' && req.method === 'POST') {
        const ip = clientIp(req, config.trustProxy)
        if (!limiter.hit(`profile-put:${ip}`, 30, 60_000)) { json(res, 429, { error: 'too many requests' }); return }
        const raw = await readBody(req, config.maxBodyBytes)
        const auth = authenticateRest(req, raw, pathname)
        if (!auth.ok) { json(res, auth.status, { error: auth.error }); return }
        upsertAuthenticatedDevice(auth)
        let body
        try { body = JSON.parse(raw || '{}') } catch { json(res, 400, { error: 'invalid JSON' }); return }
        const name = String(body.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32)
        if (!name) { json(res, 400, { error: 'name is required' }); return }
        let icon = null
        let iconType = null
        if (body.iconBase64) {
          icon = Buffer.from(String(body.iconBase64), 'base64')
          if (!icon.length || icon.length > 512 * 1024) { json(res, 400, { error: 'icon must be 1..512KB' }); return }
          const isPng = icon.length > 8 && icon.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          const isJpeg = icon.length > 3 && icon[0] === 0xff && icon[1] === 0xd8 && icon[2] === 0xff
          if (!isPng && !isJpeg) { json(res, 400, { error: 'icon must be PNG/JPEG' }); return }
          iconType = isPng ? 'image/png' : 'image/jpeg'
        }
        db.putProfile({ deviceId: auth.deviceId, name, iconType, icon })
        broadcastProfile(auth.deviceId)
        const saved = db.getProfile(auth.deviceId)
        json(res, 200, { ok: true, name, iconType: saved.icon_type || '', updatedAt: saved.updated_at })
        return
      }

      const blobMatch = pathname.match(/^\/v1\/blob\/([A-Za-z0-9_-]{10,64})$/)
      if (blobMatch && (req.method === 'PUT' || req.method === 'GET')) {
        const ip = clientIp(req, config.trustProxy)
        if (!limiter.hit(`blob:${ip}`, 60, 60_000)) { json(res, 429, { error: 'too many blob requests' }); return }
        const blobId = blobMatch[1]
        const convId = url.searchParams.get('convId') || ''
        if (!isConvId(convId)) { json(res, 400, { error: 'invalid convId' }); return }

        if (req.method === 'PUT') {
          const raw = await readBodyBuffer(req, config.maxBlobBytes)
          const auth = authenticateRest(req, raw, pathname)
          if (!auth.ok) { json(res, auth.status, { error: auth.error }); return }
          upsertAuthenticatedDevice(auth)
          const conv = db.getConversation(convId)
          if (!conv) { json(res, 404, { error: 'conversation not found' }); return }
          if (!db.peerOf(conv, auth.deviceId)) { json(res, 403, { error: 'not a conversation member' }); return }
          if (!raw.length) { json(res, 400, { error: 'empty blob' }); return }
          if (db.countBlobs(convId) >= 200) { json(res, 429, { error: 'conversation blob quota exceeded' }); return }
          const digest = crypto.createHash('sha256').update(raw).digest('hex')
          const result = db.putBlob({ blobId, convId, sender: auth.deviceId, size: raw.length, sha256: digest })
          if (!result.duplicate) {
            const file = blobFile(blobId)
            const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
            fs.writeFileSync(tmp, raw, { mode: 0o600 })
            fs.renameSync(tmp, file)
          }
          json(res, 200, { ok: true, blobId, size: raw.length, sha256: digest, duplicate: result.duplicate })
          return
        }

        const auth = authenticateRest(req, '', pathname)
        if (!auth.ok) { json(res, auth.status, { error: auth.error }); return }
        upsertAuthenticatedDevice(auth)
        const blob = db.getBlob(blobId)
        if (!blob || blob.conv_id !== convId) { json(res, 404, { error: 'blob not found' }); return }
        const conv = db.getConversation(convId)
        if (!conv || !db.peerOf(conv, auth.deviceId)) { json(res, 404, { error: 'conversation not found' }); return }
        const file = blobFile(blobId)
        if (!fs.existsSync(file)) { json(res, 404, { error: 'blob file missing' }); return }
        const bytes = fs.readFileSync(file)
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        })
        res.end(bytes)
        return
      }

      if (pathname === '/app' || pathname.startsWith('/app/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!serveStatic(req, res, config.publicDir, pathname)) json(res, 404, { error: 'not found' })
        return
      }

      const ip = clientIp(req, config.trustProxy)

      if (pathname === '/v1/bind/create' && req.method === 'POST') {
        if (!limiter.hit(`bind-create:${ip}`, 20, 60_000)) {
          json(res, 429, { error: 'too many bind requests' })
          return
        }
        const raw = await readBody(req, config.maxBodyBytes)
        const auth = authenticateRest(req, raw, pathname)
        if (!auth.ok) { json(res, auth.status, { error: auth.error }); return }
        if (!limiter.hit(`bind-create-dev:${auth.deviceId}`, 20, 60_000)) {
          json(res, 429, { error: 'too many bind requests' })
          return
        }
        upsertAuthenticatedDevice(auth)
        let body
        try { body = JSON.parse(raw || '{}') } catch { json(res, 400, { error: 'invalid JSON' }); return }
        if (body.xPub && body.xPub !== auth.xPub) { json(res, 403, { error: 'xPub does not match authenticated key' }); return }
        const result = db.createBind({
          desktopDeviceId: auth.deviceId,
          desktopEdPub: auth.edPub,
          desktopXPub: auth.xPub,
          fingerprint: String(body.fingerprint || auth.deviceId.slice(-8)).slice(0, 16),
          ttlMs: config.bindTtlMs,
        })
        json(res, 200, result)
        return
      }

      const bindMatch = pathname.match(/^\/v1\/bind\/([A-Za-z0-9_-]{8,64})$/)
      if (bindMatch && req.method === 'GET') {
        if (!limiter.hit(`bind-get:${ip}`, 60, 60_000)) { json(res, 429, { error: 'too many requests' }); return }
        const bind = db.getBind(bindMatch[1])
        if (!bind) { json(res, 404, { error: 'bind not found' }); return }
        json(res, 200, {
          bindId: bind.bind_id,
          desktopDeviceId: bind.desktop_device_id,
          desktopEdPub: bind.desktop_ed_pub,
          desktopXPub: bind.desktop_x_pub,
          nonce: bind.nonce,
          fingerprint: bind.fingerprint,
          status: bind.status,
          expiresAt: bind.expires_at,
        })
        return
      }

      const claimMatch = pathname.match(/^\/v1\/bind\/([A-Za-z0-9_-]{8,64})\/claim$/)
      if (claimMatch && req.method === 'POST') {
        if (!limiter.hit(`bind-claim:${ip}`, 10, 60_000)) { json(res, 429, { error: 'too many claim attempts' }); return }
        const raw = await readBody(req, config.maxBodyBytes)
        const auth = authenticateRest(req, raw, pathname)
        if (!auth.ok) { json(res, auth.status, { error: auth.error }); return }
        upsertAuthenticatedDevice(auth)
        let body
        try { body = JSON.parse(raw || '{}') } catch { json(res, 400, { error: 'invalid JSON' }); return }
        if (body.edPub && body.edPub !== auth.edPub) { json(res, 403, { error: 'edPub does not match authenticated key' }); return }
        if (body.xPub && body.xPub !== auth.xPub) { json(res, 403, { error: 'xPub does not match authenticated key' }); return }
        const bind = db.getBind(claimMatch[1])
        if (!bind) { json(res, 404, { error: 'bind not found' }); return }
        if (!isOnline(bind.desktop_device_id)) {
          json(res, 409, { error: '桌面端不在线，请确认 EO助手 插件已连接 relay' })
          return
        }
        let claimed
        try {
          claimed = db.claimBind({
            bindId: claimMatch[1],
            phoneDeviceId: auth.deviceId,
            phoneEdPub: auth.edPub,
            phoneXPub: auth.xPub,
            nonce: String(body.nonce || ''),
          })
        } catch (error) {
          json(res, error.status || 400, { error: error.message })
          return
        }
        sendToDevice(bind.desktop_device_id, {
          type: 'bind/claimed',
          bindId: bind.bind_id,
          code: claimed.code,
          ts: nowMs(),
        })
        json(res, 200, { ok: true, bindId: bind.bind_id, expiresAt: claimed.bind.expires_at })
        return
      }

      const confirmMatch = pathname.match(/^\/v1\/bind\/([A-Za-z0-9_-]{8,64})\/confirm$/)
      if (confirmMatch && req.method === 'POST') {
        if (!limiter.hit(`bind-confirm:${ip}`, 20, 60_000)) { json(res, 429, { error: 'too many confirmation attempts' }); return }
        const raw = await readBody(req, config.maxBodyBytes)
        const auth = authenticateRest(req, raw, pathname)
        if (!auth.ok) { json(res, auth.status, { error: auth.error }); return }
        upsertAuthenticatedDevice(auth)
        let body
        try { body = JSON.parse(raw || '{}') } catch { json(res, 400, { error: 'invalid JSON' }); return }
        const bind = db.getBind(confirmMatch[1])
        if (!bind) { json(res, 404, { error: 'bind not found' }); return }
        if (!safeEqual(bind.code || '', String(body.code || ''))) {
          json(res, 403, { error: '确认码不正确' })
          return
        }
        let result
        try {
          result = db.confirmBind({ bindId: confirmMatch[1], phoneDeviceId: auth.deviceId, code: String(body.code) })
        } catch (error) {
          json(res, error.status || 400, { error: error.message })
          return
        }
        const conv = result.conversation
        const desktopBind = result.bind
        sendToDevice(desktopBind.desktop_device_id, bindConfirmedFrame(desktopBind, conv))
        sendToDevice(conv.phone_device_id, {
          type: 'bind/confirmed',
          bindId: bind.bind_id,
          convId: conv.conv_id,
          peerDeviceId: conv.desktop_device_id,
          peerEdPub: conv.desktop_ed_pub,
          peerXPub: conv.desktop_x_pub,
          seq: 0,
          ts: nowMs(),
        })
        // Both sockets are already open when a conversation is created, so
        // announcePresence() never fires for it. Send the online state now;
        // otherwise the two clients keep showing “offline” after a fresh bind.
        sendPeerPresenceToSelf(conv.phone_device_id)
        sendPeerPresenceToSelf(conv.desktop_device_id)
        json(res, 200, {
          ok: true,
          bindId: bind.bind_id,
          convId: conv.conv_id,
          peerDeviceId: conv.desktop_device_id,
          peerEdPub: conv.desktop_ed_pub,
          peerXPub: conv.desktop_x_pub,
          title: desktopBind.fingerprint || 'EO助手',
          seq: 0,
        })
        return
      }

      if (pathname === '/v1/msg' && req.method === 'POST') {
        const raw = await readBody(req, config.maxBodyBytes)
        const auth = authenticateRest(req, raw, pathname)
        if (!auth.ok) { json(res, auth.status, { error: auth.error }); return }
        upsertAuthenticatedDevice(auth)
        let body
        try { body = JSON.parse(raw || '{}') } catch { json(res, 400, { error: 'invalid JSON' }); return }
        const result = acceptEnvelope(auth.deviceId, body.envelope)
        if (!result.ok) { json(res, result.status, { error: result.error }); return }
        json(res, 200, { ok: true, duplicate: result.duplicate })
        return
      }

      if (pathname === '/v1/history' && req.method === 'GET') {
        if (!limiter.hit(`history:${ip}`, 120, 60_000)) { json(res, 429, { error: 'too many requests' }); return }
        const auth = authenticateRest(req, '', pathname)
        if (!auth.ok) { json(res, auth.status, { error: auth.error }); return }
        upsertAuthenticatedDevice(auth)
        const convId = url.searchParams.get('convId') || ''
        if (!isConvId(convId)) { json(res, 400, { error: 'invalid convId' }); return }
        const conv = db.getConversation(convId)
        if (!conv || !db.peerOf(conv, auth.deviceId)) { json(res, 404, { error: 'conversation not found' }); return }
        const after = Number(url.searchParams.get('after') || 0)
        const limit = Number(url.searchParams.get('limit') || 200)
        json(res, 200, { messages: db.history(convId, after, limit) })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (error) {
      const status = error.status || 500
      if (status >= 500) console.error('[eo-relay] request failed', error)
      if (!res.headersSent) json(res, status, { error: status >= 500 ? 'internal error' : error.message })
      else res.end()
    }
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname !== '/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const auth = authenticateWs(url.searchParams)
    if (!auth.ok) {
      socket.write(`HTTP/1.1 ${auth.status} Unauthorized\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${auth.error}`)
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.deviceId = auth.deviceId
      wss.emit('connection', ws, req, auth)
    })
  })

  wss.on('connection', (ws, _req, auth) => {
    try {
      upsertAuthenticatedDevice(auth)
    } catch (error) {
      ws.close(1008, error.message)
      return
    }
    const wasOffline = !isOnline(auth.deviceId)
    if (!sockets.has(auth.deviceId)) sockets.set(auth.deviceId, new Set())
    sockets.get(auth.deviceId).add(ws)
    ws.bucket = { tokens: 50, at: nowMs() }

    ws.send(JSON.stringify({ type: 'hello', deviceId: auth.deviceId, ts: nowMs(), instanceId }))
    sendPeerPresenceToSelf(auth.deviceId)
    sendPendingBindNotices(auth.deviceId)
    if (wasOffline) announcePresence(auth.deviceId, true)

    ws.on('message', (data) => {
      const now = nowMs()
      const elapsed = Math.max(0, now - ws.bucket.at) / 1000
      ws.bucket.tokens = Math.min(50, ws.bucket.tokens + elapsed * 20)
      ws.bucket.at = now
      if (ws.bucket.tokens < 1) {
        ws.send(JSON.stringify({ type: 'error', error: 'rate limited' }))
        return
      }
      ws.bucket.tokens -= 1

      let frame
      try { frame = JSON.parse(String(data)) } catch { return }
      if (!frame || typeof frame !== 'object') return
      if (frame.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: nowMs() }))
        return
      }
      if (frame.type === 'pong') return
      if (frame.type === 'msg') {
        const result = acceptEnvelope(ws.deviceId, frame.envelope)
        if (!result.ok) {
          ws.send(JSON.stringify({
            type: 'error',
            error: result.error,
            code: result.status === 409 ? 'seq_conflict' : 'message_rejected',
            msgId: frame.envelope?.msgId,
          }))
          return
        }
        ws.send(JSON.stringify({ type: 'ack', msgId: frame.envelope.msgId, seq: frame.envelope.seq, duplicate: result.duplicate }))
        return
      }
      ws.send(JSON.stringify({ type: 'error', error: `unknown frame type: ${String(frame.type).slice(0, 32)}` }))
    })

    ws.on('close', () => {
      const set = sockets.get(auth.deviceId)
      if (set) {
        set.delete(ws)
        if (set.size === 0) {
          sockets.delete(auth.deviceId)
          announcePresence(auth.deviceId, false)
        }
      }
    })

    ws.on('error', () => { /* close handler owns cleanup */ })
  })

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        const address = server.address()
        resolve({ port: address.port, host: address.address })
      })
    })
  }

  function close() {
    if (closed) return Promise.resolve()
    closed = true
    for (const set of sockets.values()) {
      for (const socket of set) socket.close(1001, 'relay shutting down')
    }
    sockets.clear()
    return new Promise((resolve) => {
      wss.close(() => server.close(() => { db.close(); resolve() }))
    })
  }

  return { server, db, wss, sockets, start, close, config }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (isMain) {
  const relay = createRelay()
  const address = await relay.start()
  console.log(`[eo-relay] listening on http://${address.host}:${address.port}`)
  console.log(`[eo-relay] mobile app: http://${address.host}:${address.port}/app/`)
  const shutdown = async () => {
    await relay.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
