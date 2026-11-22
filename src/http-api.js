/**
 * Same-origin HTTP API used by the "EO助手连接" settings section.
 *
 * The settings page is a browser React component, while the relay client and
 * keys live in the host process. A custom ctx.remote namespace is not
 * plug-and-play for third-party plugins (the client composition selects Remote
 * contributions at build time), so this boundary uses ctx.webServer routes and
 * a per-process bearer token instead.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

function sendEmpty(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

function readJson(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function tokenMatches(req, token) {
  const provided = String(req.headers['x-eo-token'] || '')
  if (!provided || !token) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (origin === 'null' || origin.startsWith('file://')) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function methodIs(req, method) {
  return String(req.method || '').toUpperCase() === method
}

export function registerHttpApi({ web, state, config, relay, store, identity, log = console.log }) {
  if (!web?.register) {
    log('[eo] webServer service unavailable; settings API is disabled on this DSH profile')
    return () => {}
  }

  const disposers = []
  const route = (kind, path, handler) => {
    disposers.push(web.register({ kind, path, handler }))
  }

  const publishProfile = () => {
    let iconBase64 = ''
    try {
      if (fs.existsSync(store.iconFile())) iconBase64 = fs.readFileSync(store.iconFile()).toString('base64')
    } catch { /* icon is optional */ }
    relay.publishProfile({
      name: state.settings.assistantName,
      iconBase64,
    }).catch((error) => log(`publish profile failed: ${error.message}`))
  }

  const snapshot = () => ({
    ok: true,
    token: state.token,
    assistantName: state.settings.assistantName,
    model: typeof state.getModel === 'function' ? state.getModel() : '',
    relayUrl: state.relayUrl || config.relayUrl,
    relayKind: state.relayKind || (config.relayUrl ? 'external' : 'embedded'),
    connected: state.connected,
    relayError: state.relayError,
    deviceId: identity.deviceId,
    fingerprint: identity.deviceId.slice(-8),
    hasIcon: Boolean(state.settings.iconType),
    iconVersion: state.settings.iconVersion || 0,
    bind: state.bind
      ? {
          bindId: state.bind.bindId,
          status: state.bind.status,
          expiresAt: state.bind.expiresAt,
          code: state.bind.status === 'claimed' || state.bind.status === 'confirmed' ? state.bind.code : null,
          qrDataUrl: state.bind.qrDataUrl,
          convId: state.bind.convId || null,
        }
      : null,
    conversations: [...state.conversations.values()].map((conv) => ({
      convId: conv.convId,
      title: conv.title,
      peerDeviceId: conv.peerDeviceId,
      online: Boolean(conv.online),
      lastMessageAt: conv.lastMessageAt ?? null,
      seq: conv.seq ?? 0,
    })),
  })

  route('exact', '/eo/api/state', async (req, res) => {
    if (!methodIs(req, 'GET')) return sendEmpty(res, 405)
    sendJson(res, 200, snapshot())
  })

  route('exact', '/eo/api/bind/new', async (req, res) => {
    if (!methodIs(req, 'POST')) return sendEmpty(res, 405)
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'origin rejected' })
    if (!tokenMatches(req, state.token)) return sendJson(res, 403, { error: 'token rejected' })
    if (!config.relayUrl && !state.relayUrl) return sendJson(res, 400, { error: 'relay 尚未就绪' })
    try {
      await state.relayReady
      if (state.bind && state.bind.status === 'waiting' && state.bind.expiresAt > Date.now()) {
        return sendJson(res, 200, { ok: true, bind: snapshot().bind })
      }
      await relay.createBind()
      sendJson(res, 200, { ok: true, bind: snapshot().bind })
    } catch (error) {
      log(`[eo] bind/create failed: ${error.message}`)
      sendJson(res, 502, { error: `无法生成二维码：${error.message}` })
    }
  })

  route('exact', '/eo/api/bind/cancel', async (req, res) => {
    if (!methodIs(req, 'POST')) return sendEmpty(res, 405)
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'origin rejected' })
    if (!tokenMatches(req, state.token)) return sendJson(res, 403, { error: 'token rejected' })
    relay.cancelBind()
    sendJson(res, 200, { ok: true })
  })

  route('exact', '/eo/api/settings', async (req, res) => {
    if (!methodIs(req, 'POST')) return sendEmpty(res, 405)
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'origin rejected' })
    if (!tokenMatches(req, state.token)) return sendJson(res, 403, { error: 'token rejected' })
    try {
      const body = await readJson(req, 64 * 1024)
      if (typeof body.assistantName === 'string') {
        const name = body.assistantName.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32)
        if (!name) return sendJson(res, 400, { error: '助手名称不能为空' })
        state.settings.assistantName = name
        store.writeSettings(state.settings)
        publishProfile()
      }
      sendJson(res, 200, { ok: true, assistantName: state.settings.assistantName })
    } catch (error) {
      sendJson(res, 400, { error: error.message })
    }
  })

  route('exact', '/eo/api/icon', async (req, res) => {
    if (methodIs(req, 'POST')) {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: 'origin rejected' })
      if (!tokenMatches(req, state.token)) return sendJson(res, 403, { error: 'token rejected' })
      try {
        const body = await readJson(req, 600 * 1024)
        const dataUrl = String(body.dataUrl || '')
        const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
        if (!match) return sendJson(res, 400, { error: '只支持 PNG/JPEG 图片' })
        const bytes = Buffer.from(match[2], 'base64')
        if (bytes.length === 0 || bytes.length > 512 * 1024) return sendJson(res, 400, { error: '图片不能超过 512KB' })
        const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        if (!isPng && !isJpeg) return sendJson(res, 400, { error: '文件内容不是有效的 PNG/JPEG' })
        fs.mkdirSync(store.root, { recursive: true, mode: 0o700 })
        fs.writeFileSync(store.iconFile(), bytes, { mode: 0o600 })
        state.settings.iconType = isPng ? 'image/png' : 'image/jpeg'
        state.settings.iconVersion = Date.now()
        store.writeSettings(state.settings)
        publishProfile()
        return sendJson(res, 200, { ok: true, iconVersion: state.settings.iconVersion })
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }
    }

    if (!methodIs(req, 'GET')) return sendEmpty(res, 405)
    try {
      const file = store.iconFile()
      if (!fs.existsSync(file)) return sendEmpty(res, 404)
      const stat = fs.statSync(file)
      const etag = `W/"${state.settings.iconVersion || stat.mtimeMs}-${stat.size}"`
      if (req.headers['if-none-match'] === etag) return sendEmpty(res, 304)
      res.writeHead(200, {
        'content-type': state.settings.iconType || 'image/png',
        'cache-control': 'no-cache',
        etag,
        'x-content-type-options': 'nosniff',
      })
      res.end(fs.readFileSync(file))
    } catch {
      sendEmpty(res, 404)
    }
  })

  route('exact', '/eo/api/unbind', async (req, res) => {
    if (!methodIs(req, 'POST')) return sendEmpty(res, 405)
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'origin rejected' })
    if (!tokenMatches(req, state.token)) return sendJson(res, 403, { error: 'token rejected' })
    try {
      const body = await readJson(req, 32 * 1024)
      const convId = String(body.convId || '')
      if (state.conversations.delete(convId)) {
        state.persist?.()
        store.writeIndex(state.conversations)
      }
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 400, { error: error.message })
    }
  })

  route('exact', '/eo/api/health', async (req, res) => {
    if (!methodIs(req, 'GET')) return sendEmpty(res, 405)
    sendJson(res, 200, { ok: true, connected: state.connected, bindings: state.conversations.size })
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
    disposers.length = 0
  }
}
