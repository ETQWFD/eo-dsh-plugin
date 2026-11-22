/**
 * Ed25519 verification and request authentication.
 *
 * REST signature (implemented by the DSH plugin and mobile client):
 *   canonical = METHOD + "\n" + pathname + "\n" + ts + "\n" + sha256hex(rawBody)
 *   headers   = x-eo-device, x-eo-ts, x-eo-sig, x-eo-ed, x-eo-x
 *
 * WebSocket signature:
 *   canonical = "ws\n" + deviceId + "\n" + ts
 *   query     = deviceId, ts, ed, x, sig
 *
 * The deviceId is derived from the Ed25519 public key, so a caller cannot
 * claim another device's id without its private key.
 */
import crypto from 'node:crypto'
import { base32, fromBase64url, sha256hex } from './protocol.js'

const ED_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const MAX_SKEW_MS = 5 * 60_000

export function deriveDeviceId(edRawPublic) {
  return `eo1_${base32(crypto.createHash('sha256').update(edRawPublic).digest()).slice(0, 16)}`
}

export function edPublicFromRaw(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([ED_SPKI_PREFIX, Buffer.from(raw)]) ,
    format: 'der',
    type: 'spki',
  })
}

export function verifyEd25519(text, signature, edRawPublic) {
  try {
    return crypto.verify(
      null,
      Buffer.from(text, 'utf8'),
      edPublicFromRaw(Buffer.from(edRawPublic)),
      Buffer.from(signature),
    )
  } catch {
    return false
  }
}

function header(req, name) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Authenticate a REST request.
 * @returns {{ ok: true, deviceId: string, edPub: string, xPub: string, ts: number } | { ok: false, status: number, error: string }}
 */
export function authenticateRest(req, rawBody, pathname, options = {}) {
  const deviceId = header(req, 'x-eo-device')
  const tsText = header(req, 'x-eo-ts')
  const sigText = header(req, 'x-eo-sig')
  const edText = header(req, 'x-eo-ed')
  const xText = header(req, 'x-eo-x')
  if (!deviceId || !tsText || !sigText || !edText || !xText) {
    return { ok: false, status: 401, error: 'missing authentication headers' }
  }

  const ts = Number(tsText)
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > (options.maxSkewMs ?? MAX_SKEW_MS)) {
    return { ok: false, status: 401, error: 'stale or invalid timestamp' }
  }

  let edPub
  let xPub
  let sig
  try {
    edPub = fromBase64url(edText)
    xPub = fromBase64url(xText)
    sig = fromBase64url(sigText)
  } catch {
    return { ok: false, status: 401, error: 'invalid base64url key material' }
  }
  if (edPub.length !== 32 || xPub.length !== 32) {
    return { ok: false, status: 401, error: 'invalid key length' }
  }

  const expectedId = deriveDeviceId(edPub)
  if (expectedId !== deviceId) {
    return { ok: false, status: 401, error: 'device id does not match signing key' }
  }

  const canonical = `${req.method}\n${pathname}\n${ts}\n${sha256hex(rawBody)}`
  if (!verifyEd25519(canonical, sig, edPub)) {
    return { ok: false, status: 401, error: 'bad request signature' }
  }

  return { ok: true, deviceId, edPub: edText, xPub: xText, ts }
}

/** Authenticate the WebSocket upgrade query. */
export function authenticateWs(searchParams) {
  const deviceId = searchParams.get('deviceId')
  const tsText = searchParams.get('ts')
  const edText = searchParams.get('ed')
  const xText = searchParams.get('x')
  const sigText = searchParams.get('sig')
  if (!deviceId || !tsText || !edText || !xText || !sigText) {
    return { ok: false, status: 401, error: 'missing websocket authentication' }
  }
  const ts = Number(tsText)
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return { ok: false, status: 401, error: 'stale or invalid timestamp' }
  }

  let edPub
  let xPub
  let sig
  try {
    edPub = fromBase64url(edText)
    xPub = fromBase64url(xText)
    sig = fromBase64url(sigText)
  } catch {
    return { ok: false, status: 401, error: 'invalid base64url key material' }
  }
  if (edPub.length !== 32 || xPub.length !== 32) {
    return { ok: false, status: 401, error: 'invalid key length' }
  }
  if (deriveDeviceId(edPub) !== deviceId) {
    return { ok: false, status: 401, error: 'device id does not match signing key' }
  }
  if (!verifyEd25519(`ws\n${deviceId}\n${ts}`, sig, edPub)) {
    return { ok: false, status: 401, error: 'bad websocket signature' }
  }
  return { ok: true, deviceId, edPub: edText, xPub: xText, ts }
}

/** Constant-time string comparison for the 6-digit bind code. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}
