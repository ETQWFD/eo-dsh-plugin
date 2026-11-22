/**
 * Relay transport: signed REST calls + one authenticated WebSocket.
 *
 * Protocol (stage 1):
 *   POST /v1/bind/create           desktop signed, returns bindId/nonce/expiry
 *   GET  /v1/bind/:id              public, returns desktop public keys
 *   POST /v1/bind/:id/claim        phone signed, relay pushes code to desktop
 *   POST /v1/bind/:id/confirm      phone signed with the 6-digit code
 *   POST /v1/msg                   encrypted envelope
 *   GET  /v1/history               encrypted backlog after seq
 *   WS   /v1/ws                    signed query, presence + push
 */
import crypto from 'node:crypto'
import { base64url, canonicalEnvelope, envelopeAad, fromBase64url, nowMs, randomId, sha256hex, toHttpUrl, toWsUrl } from './protocol.js'
import { verifyEd25519 } from './identity.js'
import { buildBindPayload, makeQrDataUrl } from './qr.js'

const HEARTBEAT_MS = 20_000
const STALE_MS = 55_000
const RECONNECT_MAX_MS = 30_000

export class RelayClient {
  constructor({ config, identity, state, handlers, log = console.log }) {
    this.config = config
    this.identity = identity
    this.state = state
    this.handlers = handlers
    this.log = log
    this.ws = null
    this.stopped = true
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.lastPong = 0
    this.backoff = 1000
    this.queue = []
    this.bindCounter = 0
  }

  start() {
    this.stopped = false
    if (!this.config.relayUrl) {
      this.setStatus(false, '未配置 relayUrl')
      return
    }
    this.connect()
  }

  stop() {
    this.stopped = true
    this.state.connected = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.reconnectTimer = null
    this.heartbeatTimer = null
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
  }

  setStatus(connected, error = '') {
    this.state.connected = connected
    this.state.relayError = error
    this.handlers.onStatus?.(connected, error)
  }

  httpBase() {
    return toHttpUrl(this.config.relayUrl)
  }

  async request(method, pathname, bodyObject) {
    const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject)
    return this.requestRaw(method, pathname, body ? Buffer.from(body) : Buffer.alloc(0), true)
  }

  /**
   * Signed request with an arbitrary body. Used by the binary blob endpoints;
   * the signature covers sha256(raw bytes), not JSON.stringify().
   */
  async requestRaw(method, pathname, bodyBuffer, json = false) {
    const url = new URL(pathname, this.httpBase())
    const body = bodyBuffer ?? Buffer.alloc(0)
    const ts = String(nowMs())
    const canonical = `${method}\n${url.pathname}\n${ts}\n${sha256hex(body)}`
    const sig = base64url(this.identity.sign(canonical))
    const res = await fetch(url, {
      method,
      headers: {
        accept: json ? 'application/json' : 'application/octet-stream',
        'content-type': json ? 'application/json' : 'application/octet-stream',
        'x-eo-device': this.identity.deviceId,
        'x-eo-ts': ts,
        'x-eo-sig': sig,
        'x-eo-ed': base64url(this.identity.edPublicRaw),
        'x-eo-x': base64url(this.identity.xPublicRaw),
      },
      body: body.length ? body : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let data = {}
      try { data = text ? JSON.parse(text) : {} } catch { data = { error: text.slice(0, 200) } }
      throw new Error(data.error || `relay HTTP ${res.status}`)
    }
    if (json) {
      const text = await res.text()
      let data = {}
      try { data = text ? JSON.parse(text) : {} } catch { data = { error: text.slice(0, 200) } }
      return data
    }
    return Buffer.from(await res.arrayBuffer())
  }

  async publishProfile({ name, iconBase64 = '' }) {
    if (!this.config.relayUrl) return null
    return this.request('POST', '/v1/profile', {
      name,
      iconBase64: iconBase64 || undefined,
    })
  }

  async uploadBlob(conv, blobId, ciphertext) {
    const query = new URLSearchParams({ convId: conv.convId })
    return this.requestRaw('PUT', `/v1/blob/${encodeURIComponent(blobId)}?${query.toString()}`, ciphertext)
  }

  async downloadBlob(conv, blobId) {
    const query = new URLSearchParams({ convId: conv.convId })
    return this.requestRaw('GET', `/v1/blob/${encodeURIComponent(blobId)}?${query.toString()}`, Buffer.alloc(0))
  }

  /**
   * Fetch, decrypt and integrity-check a phone attachment. The blob is
   * ciphertext at rest on the relay; meta travels inside the signed envelope.
   */
  async downloadAttachment(conv, meta, maxBytes = 16 * 1024 * 1024) {
    if (!meta?.blobId || !meta?.blobNonce || !meta?.blobAad) throw new Error('attachment metadata incomplete')
    if (Number(meta.size) > maxBytes) throw new Error('attachment exceeds configured size limit')
    const ciphertext = await this.downloadBlob(conv, meta.blobId)
    if (ciphertext.length > maxBytes + 32) throw new Error('attachment exceeds configured size limit')
    const plain = this.identity.decryptBytes(conv.key, meta.blobNonce, ciphertext, meta.blobAad)
    if (Number(meta.size) && plain.length !== Number(meta.size)) throw new Error('attachment size mismatch')
    if (meta.sha256) {
      const digest = crypto.createHash('sha256').update(plain).digest('hex')
      if (digest !== meta.sha256) throw new Error('attachment checksum mismatch')
    }
    return plain
  }

  async createBind() {
    if (!this.config.relayUrl) throw new Error('未配置 relayUrl')
    const result = await this.request('POST', '/v1/bind/create', {
      xPub: base64url(this.identity.xPublicRaw),
      fingerprint: this.identity.deviceId.slice(-8),
    })
    const payload = buildBindPayload({
      relayUrl: this.config.relayUrl,
      bindId: result.bindId,
      desktopXPub: base64url(this.identity.xPublicRaw),
      nonce: result.nonce,
      fingerprint: this.identity.deviceId.slice(-8),
      assistantName: this.state.settings?.assistantName || this.config.assistantName,
    })
    const qrDataUrl = await makeQrDataUrl(payload)
    this.state.bind = {
      bindId: result.bindId,
      status: 'waiting',
      expiresAt: result.expiresAt,
      qrDataUrl,
      code: null,
      createdAt: nowMs(),
    }
    this.bindCounter += 1
    return this.state.bind
  }

  cancelBind() {
    this.state.bind = null
  }

  connect() {
    if (this.stopped || !this.config.relayUrl) return
    let url
    try {
      const base = toWsUrl(this.config.relayUrl)
      base.pathname = '/v1/ws'
      base.search = ''
      const ts = String(nowMs())
      base.searchParams.set('deviceId', this.identity.deviceId)
      base.searchParams.set('ts', ts)
      base.searchParams.set('ed', base64url(this.identity.edPublicRaw))
      base.searchParams.set('x', base64url(this.identity.xPublicRaw))
      base.searchParams.set('sig', base64url(this.identity.sign(`ws\n${this.identity.deviceId}\n${ts}`)))
      url = base
    } catch (error) {
      this.setStatus(false, String(error.message || error))
      return
    }

    this.log(`[eo] connecting relay ${url.origin}`)
    let socket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      this.setStatus(false, String(error.message || error))
      this.scheduleReconnect()
      return
    }
    this.ws = socket

    socket.addEventListener('open', () => {
      this.backoff = 1000
      this.lastPong = nowMs()
      this.setStatus(true, '')
      this.flushQueue()
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    })

    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
      this.onFrame(raw)
    })

    socket.addEventListener('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      this.setStatus(false, '连接已断开')
      if (!this.stopped) this.scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      // The close handler owns reconnect and user-visible state.
    })
  }

  scheduleReconnect() {
    if (this.stopped) return
    if (this.reconnectTimer) return
    const delay = this.backoff + Math.floor(Math.random() * 500)
    this.backoff = Math.min(Math.round(this.backoff * 1.8), RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  heartbeat() {
    if (!this.isOpen()) return
    if (nowMs() - this.lastPong > STALE_MS) {
      this.log('[eo] relay heartbeat stale, reconnecting')
      try { this.ws.close() } catch { /* ignore */ }
      return
    }
    this.sendFrame({ type: 'ping', ts: nowMs() })
  }

  isOpen() {
    return this.ws !== null && this.ws.readyState === 1
  }

  sendFrame(frame) {
    if (this.isOpen()) {
      this.ws.send(JSON.stringify(frame))
      return
    }
    if (this.queue.length < 100) this.queue.push(frame)
  }

  flushQueue() {
    const pending = this.queue
    this.queue = []
    for (const frame of pending) {
      if (!this.isOpen()) { this.queue.push(frame); break }
      this.ws.send(JSON.stringify(frame))
    }
  }

  onFrame(raw) {
    let frame
    try { frame = JSON.parse(raw) } catch { return }
    this.lastPong = nowMs()
    switch (frame.type) {
      case 'hello':
        this.setStatus(true, '')
        break
      case 'pong':
        break
      case 'bind/claimed': {
        if (!this.state.bind || this.state.bind.bindId !== frame.bindId) break
        this.state.bind.status = 'claimed'
        this.state.bind.code = frame.code
        this.handlers.onBindClaimed?.(this.state.bind)
        break
      }
      case 'bind/confirmed': {
        if (!this.state.bind || this.state.bind.bindId !== frame.bindId) break
        const key = this.identity.sharedKey(frame.peerXPub, frame.convId)
        const conv = {
          convId: frame.convId,
          title: this.state.settings?.assistantName || this.config.assistantName,
          peerDeviceId: frame.peerDeviceId,
          peerEdPub: frame.peerEdPub,
          peerXPub: frame.peerXPub,
          key,
          seq: Number(frame.seq || 0),
          online: true,
          createdAt: nowMs(),
          lastMessageAt: null,
        }
        this.state.bind.status = 'confirmed'
        this.state.bind.convId = frame.convId
        this.state.bind.code = null
        this.handlers.onBindConfirmed?.(conv)
        break
      }
      case 'msg': {
        const envelope = frame.envelope
        if (!envelope) break
        const conv = this.state.conversations.get(envelope.convId)
        if (!conv) break
        // Both ends may start at seq 1. Track the peer's high-water mark so the
        // next outbound message never reuses a seq already stored by the relay.
        conv.seq = Math.max(Number(conv.seq || 0), Number(envelope.seq) || 0)
        this.handlers.onSeq?.(conv)
        try {
          const valid = verifyEd25519(canonicalEnvelope(envelope), fromBase64url(envelope.sig), fromBase64url(conv.peerEdPub))
          if (!valid) throw new Error('bad message signature')
          const plaintext = this.identity.decrypt(conv.key, envelope.nonce, envelope.ct, envelopeAad(envelope))
          let payload
          try { payload = JSON.parse(plaintext) } catch { payload = { text: plaintext } }
          this.handlers.onMessage?.(conv, {
            msgId: envelope.msgId,
            seq: Number(envelope.seq),
            kind: envelope.kind,
            sender: envelope.sender,
            ts: Number(envelope.ts),
            text: String(payload.text ?? ''),
            meta: payload.meta ?? null,
          })
        } catch (error) {
          this.log(`[eo] dropped message: ${error.message}`)
        }
        break
      }
      case 'presence': {
        const conv = this.state.conversations.get(frame.convId)
        if (!conv) break
        conv.online = Boolean(frame.online)
        conv.lastSeenAt = frame.ts || nowMs()
        this.handlers.onPresence?.(conv, conv.online)
        break
      }
      case 'error':
        this.log(`[eo] relay error: ${frame.error}`)
        this.state.relayError = String(frame.error || 'relay error')
        break
      default:
        break
    }
  }

  sendText(conv, text) {
    return this.sendPayload(conv, {
      kind: 'text',
      text,
      meta: null,
    })
  }

  sendPayload(conv, { kind = 'text', text = '', meta = null }) {
    const payload = JSON.stringify({ text, meta })
    const envelope = {
      v: 1,
      convId: conv.convId,
      msgId: randomId('m'),
      seq: (conv.seq || 0) + 1,
      kind,
      sender: this.identity.deviceId,
      ts: nowMs(),
      nonce: '',
      ct: '',
      meta: null,
    }
    conv.seq = envelope.seq
    const aad = envelopeAad(envelope)
    const encrypted = this.identity.encrypt(conv.key, payload, aad)
    envelope.nonce = encrypted.nonce
    envelope.ct = encrypted.ct
    envelope.sig = base64url(this.identity.sign(canonicalEnvelope(envelope)))
    this.sendFrame({ type: 'msg', envelope })
    this.handlers.onOutbound?.(conv, {
      msgId: envelope.msgId,
      seq: envelope.seq,
      kind: envelope.kind,
      sender: envelope.sender,
      ts: envelope.ts,
      text,
      meta,
    })
    return envelope
  }

  async history(conv, after = 0) {
    const query = new URLSearchParams({ convId: conv.convId, after: String(after), limit: '200' })
    const result = await this.request('GET', `/v1/history?${query.toString()}`)
    return result.messages || []
  }
}
