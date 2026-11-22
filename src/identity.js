/**
 * Device identity and message cryptography.
 *
 * Desktop: Ed25519 signing key + X25519 key agreement key, both generated
 * locally. The private halves never leave this machine and are written with
 * mode 0600. The relay only receives public keys.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { base32, base64url, fromBase64url } from './protocol.js'

const ED_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const X_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const ED_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const X_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const IV_BYTES = 12
const TAG_BYTES = 16

function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, file)
}

function keyFromPkcs8(der, type) {
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

function keyFromSpki(der) {
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
}

function privateDer(privateKey) {
  return privateKey.export({ format: 'der', type: 'pkcs8' })
}

function publicDer(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' })
}

function rawEdPublic(edSpkiDer) {
  return edSpkiDer.subarray(ED_SPKI_PREFIX.length)
}

function rawXPublic(xSpkiDer) {
  return xSpkiDer.subarray(X_SPKI_PREFIX.length)
}

export function deriveDeviceId(edRawPublic) {
  return `eo1_${base32(crypto.createHash('sha256').update(edRawPublic).digest()).slice(0, 16)}`
}

export function edPublicFromRaw(raw) {
  return keyFromSpki(Buffer.concat([ED_SPKI_PREFIX, Buffer.from(raw)]))
}

export function xPublicFromRaw(raw) {
  return keyFromSpki(Buffer.concat([X_SPKI_PREFIX, Buffer.from(raw)]))
}

export function verifyEd25519(text, signature, edRawPublic) {
  try {
    return crypto.verify(null, Buffer.from(text, 'utf8'), edPublicFromRaw(edRawPublic), Buffer.from(signature))
  } catch {
    return false
  }
}

export class DeviceIdentity {
  constructor(data) {
    this.deviceId = data.deviceId
    this.edPrivateKey = keyFromPkcs8(Buffer.from(data.edPrivate, 'base64'))
    this.xPrivateKey = keyFromPkcs8(Buffer.from(data.xPrivate, 'base64'))
    this.edPrivateDer = Buffer.from(data.edPrivate, 'base64')
    this.xPrivateDer = Buffer.from(data.xPrivate, 'base64')
    this.edPublicDer = Buffer.from(data.edPublic, 'base64')
    this.xPublicDer = Buffer.from(data.xPublic, 'base64')
    this.edPublicRaw = Buffer.from(data.edPublicRaw, 'base64')
    this.xPublicRaw = Buffer.from(data.xPublicRaw, 'base64')
    this.createdAt = data.createdAt
  }

  sign(text) {
    return crypto.sign(null, Buffer.from(text, 'utf8'), this.edPrivateKey)
  }

  /** X25519 shared secret -> HKDF-SHA256 -> 32-byte conversation key. */
  sharedKey(peerXPublicRaw, convId) {
    const peer = xPublicFromRaw(fromBase64url(peerXPublicRaw))
    const secret = crypto.diffieHellman({ privateKey: this.xPrivateKey, publicKey: peer })
    return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(convId), Buffer.from('eo-conv-v1'), 32))
  }

  encrypt(key, plaintext, aad) {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      nonce: base64url(iv),
      ct: base64url(Buffer.concat([body, tag])),
    }
  }

  decrypt(key, nonce, ct, aad) {
    const iv = fromBase64url(nonce)
    const payload = fromBase64url(ct)
    if (iv.length !== IV_BYTES || payload.length < TAG_BYTES) throw new Error('invalid ciphertext')
    const body = payload.subarray(0, payload.length - TAG_BYTES)
    const tag = payload.subarray(payload.length - TAG_BYTES)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }

  toJSON() {
    return {
      v: 1,
      deviceId: this.deviceId,
      edPrivate: this.edPrivateDer.toString('base64'),
      edPublic: this.edPublicDer.toString('base64'),
      xPrivate: this.xPrivateDer.toString('base64'),
      xPublic: this.xPublicDer.toString('base64'),
      edPublicRaw: this.edPublicRaw.toString('base64'),
      xPublicRaw: this.xPublicRaw.toString('base64'),
      createdAt: this.createdAt,
    }
  }
}

/**
 * Load or create the desktop device identity under <dataDir>/identity.json.
 * @param {string} dataDir
 * @returns {DeviceIdentity}
 */
export function loadIdentity(dataDir) {
  const file = path.join(dataDir, 'identity.json')
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const identity = new DeviceIdentity(parsed)
    const expected = deriveDeviceId(identity.edPublicRaw)
    if (expected !== identity.deviceId) throw new Error('identity file is corrupted: deviceId mismatch')
    return identity
  }

  const ed = crypto.generateKeyPairSync('ed25519')
  const x = crypto.generateKeyPairSync('x25519')
  const edSpki = publicDer(ed.publicKey)
  const xSpki = publicDer(x.publicKey)
  const edRaw = rawEdPublic(edSpki)
  const xRaw = rawXPublic(xSpki)
  const data = {
    v: 1,
    deviceId: deriveDeviceId(edRaw),
    edPrivate: privateDer(ed.privateKey).toString('base64'),
    edPublic: edSpki.toString('base64'),
    xPrivate: privateDer(x.privateKey).toString('base64'),
    xPublic: xSpki.toString('base64'),
    edPublicRaw: edRaw.toString('base64'),
    xPublicRaw: xRaw.toString('base64'),
    createdAt: Date.now(),
  }
  atomicWrite(file, JSON.stringify(data, null, 2))
  return new DeviceIdentity(data)
}

export function rawPrivatePrefixes() {
  return { ED_PKCS8_PREFIX, X_PKCS8_PREFIX }
}
