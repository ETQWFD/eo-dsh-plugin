/**
 * Shared wire helpers for the EO Assistant DSH plugin.
 *
 * The relay implements the same canonical strings. Keep this file in sync with
 * eo-assistant/apps/relay/src/protocol.js when the envelope changes.
 */
import crypto from 'node:crypto'

export const ENVELOPE_VERSION = 1
export const CONV_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function fromBase64url(value) {
  const text = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const pad = text.length % 8 === 0 ? '' : '='.repeat(8 - (text.length % 8))
  return Buffer.from(text + pad, 'base64')
}

export function base32(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

export function randomId(prefix = 'id') {
  return `${prefix}_${base64url(crypto.randomBytes(12))}`
}

export function randomToken() {
  return base64url(crypto.randomBytes(24))
}

export function nowMs() {
  return Date.now()
}

/**
 * Canonical JSON used for message signatures.
 * @param {Record<string, unknown>} e
 * @returns {string}
 */
export function canonicalEnvelope(e) {
  return JSON.stringify([
    e.v,
    e.convId,
    e.msgId,
    e.seq,
    e.kind,
    e.sender,
    e.ts,
    e.nonce,
    e.ct,
    e.meta ?? null,
  ])
}

/** AEAD associated data; binds ciphertext to conversation and message identity. */
export function envelopeAad(e) {
  return `eo|${e.v}|${e.convId}|${e.msgId}|${e.seq}|${e.sender}|${e.ts}`
}

/** Normalize ws(s):// or http(s):// to a WebSocket base URL. */
export function toWsUrl(relayUrl) {
  const url = new URL(relayUrl)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported relay protocol: ${url.protocol}`)
  }
  return url
}

/** Normalize ws(s):// or http(s):// to an HTTP base URL. */
export function toHttpUrl(relayUrl) {
  const url = new URL(relayUrl)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported relay protocol: ${url.protocol}`)
  }
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url
}

export function isConvId(value) {
  return typeof value === 'string' && CONV_ID_RE.test(value)
}
