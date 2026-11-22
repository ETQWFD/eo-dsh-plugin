/**
 * Relay persistence. Node 24's built-in `node:sqlite` keeps deployment to a
 * single process + one file, with no native module to compile. For multi-node
 * deployment, replace this module with Postgres; the server only calls the
 * methods below.
 */
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { base64url, nowMs, randomId } from './protocol.js'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  ed_pub TEXT NOT NULL,
  x_pub TEXT NOT NULL,
  fingerprint TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS binds (
  bind_id TEXT PRIMARY KEY,
  desktop_device_id TEXT NOT NULL,
  desktop_ed_pub TEXT NOT NULL,
  desktop_x_pub TEXT NOT NULL,
  nonce TEXT NOT NULL,
  fingerprint TEXT,
  code TEXT,
  status TEXT NOT NULL,
  phone_device_id TEXT,
  phone_ed_pub TEXT,
  phone_x_pub TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_binds_desktop ON binds(desktop_device_id, created_at);
CREATE TABLE IF NOT EXISTS conversations (
  conv_id TEXT PRIMARY KEY,
  desktop_device_id TEXT NOT NULL,
  phone_device_id TEXT NOT NULL,
  desktop_ed_pub TEXT NOT NULL,
  desktop_x_pub TEXT NOT NULL,
  phone_ed_pub TEXT NOT NULL,
  phone_x_pub TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conv_desktop ON conversations(desktop_device_id);
CREATE INDEX IF NOT EXISTS idx_conv_phone ON conversations(phone_device_id);
CREATE TABLE IF NOT EXISTS messages (
  row_order INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(conv_id, msg_id),
  UNIQUE(conv_id, sender, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, row_order);
CREATE TABLE IF NOT EXISTS blobs (
  blob_id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_conv ON blobs(conv_id, created_at);
CREATE TABLE IF NOT EXISTS profiles (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_type TEXT,
  icon BLOB,
  updated_at INTEGER NOT NULL
);
`

export class RelayDb {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec(SCHEMA)
    this.upsertDeviceStmt = this.db.prepare(`
      INSERT INTO devices (device_id, ed_pub, x_pub, fingerprint, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `)
  }

  close() {
    this.db.close()
  }

  upsertDevice({ deviceId, edPub, xPub, fingerprint = '' }) {
    const existing = this.getDevice(deviceId)
    if (existing && (existing.ed_pub !== edPub || existing.x_pub !== xPub)) {
      throw Object.assign(new Error('device key material changed'), { status: 409 })
    }
    const now = nowMs()
    this.upsertDeviceStmt.run(deviceId, edPub, xPub, fingerprint || null, existing?.created_at ?? now, now)
  }

  getDevice(deviceId) {
    return this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId)
  }

  touchDevice(deviceId) {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(nowMs(), deviceId)
  }

  createBind({ desktopDeviceId, desktopEdPub, desktopXPub, fingerprint = '', ttlMs = 120_000 }) {
    const now = nowMs()
    this.db.prepare(`
      UPDATE binds SET status = 'expired'
      WHERE desktop_device_id = ? AND status IN ('waiting', 'claimed') AND expires_at <= ?
    `).run(desktopDeviceId, now)
    const bindId = `b_${base64url(crypto.randomBytes(12))}`
    const nonce = base64url(crypto.randomBytes(18))
    this.db.prepare(`
      INSERT INTO binds (bind_id, desktop_device_id, desktop_ed_pub, desktop_x_pub, nonce, fingerprint, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
    `).run(bindId, desktopDeviceId, desktopEdPub, desktopXPub, nonce, fingerprint || null, now, now + ttlMs)
    return { bindId, nonce, expiresAt: now + ttlMs }
  }

  getBind(bindId) {
    const row = this.db.prepare('SELECT * FROM binds WHERE bind_id = ?').get(bindId)
    if (!row) return null
    if (row.status !== 'confirmed' && row.expires_at <= nowMs()) {
      this.db.prepare("UPDATE binds SET status = 'expired' WHERE bind_id = ?").run(bindId)
      row.status = 'expired'
    }
    return row
  }

  claimBind({ bindId, phoneDeviceId, phoneEdPub, phoneXPub, nonce }) {
    const bind = this.getBind(bindId)
    if (!bind) throw Object.assign(new Error('bind not found'), { status: 404 })
    if (bind.status === 'expired') throw Object.assign(new Error('二维码已过期'), { status: 410 })
    if (bind.status === 'confirmed') throw Object.assign(new Error('二维码已被使用'), { status: 409 })
    if (bind.nonce !== nonce) throw Object.assign(new Error('二维码 nonce 不匹配'), { status: 409 })
    if (bind.status === 'claimed' && bind.phone_device_id !== phoneDeviceId) {
      throw Object.assign(new Error('二维码已被另一台手机认领'), { status: 409 })
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    this.db.prepare(`
      UPDATE binds
      SET status = 'claimed', phone_device_id = ?, phone_ed_pub = ?, phone_x_pub = ?,
          code = ?, claimed_at = ?
      WHERE bind_id = ?
    `).run(phoneDeviceId, phoneEdPub, phoneXPub, code, nowMs(), bindId)
    return { code, bind: this.getBind(bindId) }
  }

  confirmBind({ bindId, phoneDeviceId, code }) {
    const bind = this.getBind(bindId)
    if (!bind) throw Object.assign(new Error('bind not found'), { status: 404 })
    if (bind.status === 'expired') throw Object.assign(new Error('二维码已过期'), { status: 410 })
    if (bind.status === 'confirmed') {
      const existing = bind.phone_device_id === phoneDeviceId
        ? this.findConversation(bind.desktop_device_id, phoneDeviceId)
        : null
      if (existing) return { conversation: existing, bind, replay: true }
      throw Object.assign(new Error('二维码已被使用'), { status: 409 })
    }
    if (bind.status !== 'claimed') throw Object.assign(new Error('手机尚未认领二维码'), { status: 409 })
    if (bind.phone_device_id !== phoneDeviceId) {
      throw Object.assign(new Error('二维码由另一台手机持有'), { status: 409 })
    }
    if (bind.code !== String(code)) throw Object.assign(new Error('确认码不正确'), { status: 403 })

    const existing = this.findConversation(bind.desktop_device_id, phoneDeviceId)
    if (existing) {
      this.db.prepare("UPDATE binds SET status = 'confirmed', confirmed_at = ? WHERE bind_id = ?").run(nowMs(), bindId)
      return { conversation: existing, bind: this.getBind(bindId), replay: false }
    }

    const convId = `c_${base64url(crypto.randomBytes(12))}`
    const now = nowMs()
    this.db.prepare(`
      INSERT INTO conversations
        (conv_id, desktop_device_id, phone_device_id, desktop_ed_pub, desktop_x_pub, phone_ed_pub, phone_x_pub, last_seq, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      convId,
      bind.desktop_device_id,
      phoneDeviceId,
      bind.desktop_ed_pub,
      bind.desktop_x_pub,
      bind.phone_ed_pub,
      bind.phone_x_pub,
      now,
    )
    this.db.prepare("UPDATE binds SET status = 'confirmed', confirmed_at = ? WHERE bind_id = ?").run(now, bindId)
    return { conversation: this.getConversation(convId), bind: this.getBind(bindId), replay: false }
  }

  findConversation(desktopDeviceId, phoneDeviceId) {
    return this.db.prepare(`
      SELECT * FROM conversations WHERE desktop_device_id = ? AND phone_device_id = ?
    `).get(desktopDeviceId, phoneDeviceId)
  }

  getConversation(convId) {
    return this.db.prepare('SELECT * FROM conversations WHERE conv_id = ?').get(convId)
  }

  conversationsFor(deviceId) {
    return this.db.prepare(`
      SELECT * FROM conversations WHERE desktop_device_id = ? OR phone_device_id = ?
    `).all(deviceId, deviceId)
  }

  peerOf(conv, deviceId) {
    if (conv.desktop_device_id === deviceId) {
      return {
        deviceId: conv.phone_device_id,
        edPub: conv.phone_ed_pub,
        xPub: conv.phone_x_pub,
        role: 'phone',
      }
    }
    if (conv.phone_device_id === deviceId) {
      return {
        deviceId: conv.desktop_device_id,
        edPub: conv.desktop_ed_pub,
        xPub: conv.desktop_x_pub,
        role: 'desktop',
      }
    }
    return null
  }

  /**
   * Store one envelope. Returns duplicate=true when the same msgId was already
   * accepted; a different msgId with the same (sender, seq) is a conflict.
   */
  insertMessage(conv, envelope) {
    const existing = this.db.prepare(`
      SELECT msg_id, sender, seq FROM messages WHERE conv_id = ? AND msg_id = ?
    `).get(conv.conv_id, envelope.msgId)
    if (existing) return { duplicate: true, seqConflict: false }

    const sameSeq = this.db.prepare(`
      SELECT msg_id FROM messages WHERE conv_id = ? AND sender = ? AND seq = ?
    `).get(conv.conv_id, envelope.sender, envelope.seq)
    if (sameSeq) return { duplicate: false, seqConflict: true }

    const now = nowMs()
    this.db.prepare(`
      INSERT INTO messages (conv_id, seq, msg_id, sender, kind, ts, envelope, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conv.conv_id, envelope.seq, envelope.msgId, envelope.sender, envelope.kind, envelope.ts, JSON.stringify(envelope), now)
    this.db.prepare(`
      UPDATE conversations
      SET last_seq = MAX(last_seq, ?), last_message_at = ?
      WHERE conv_id = ?
    `).run(envelope.seq, now, conv.conv_id)
    return { duplicate: false, seqConflict: false }
  }

  history(convId, after = 0, limit = 200) {
    return this.db.prepare(`
      SELECT envelope FROM messages
      WHERE conv_id = ? AND seq > ?
      ORDER BY row_order ASC
      LIMIT ?
    `).all(convId, Number(after) || 0, Math.min(Math.max(Number(limit) || 200, 1), 200))
      .map(row => JSON.parse(row.envelope))
  }

  pendingBindNotices(desktopDeviceId) {
    const since = nowMs() - 10 * 60_000
    return this.db.prepare(`
      SELECT * FROM binds
      WHERE desktop_device_id = ? AND status IN ('claimed', 'confirmed') AND created_at >= ?
      ORDER BY created_at DESC LIMIT 5
    `).all(desktopDeviceId, since)
  }

  putBlob({ blobId, convId, sender, size, sha256 }) {
    const existing = this.getBlob(blobId)
    if (existing) {
      if (existing.conv_id !== convId || existing.sender !== sender) {
        throw Object.assign(new Error('blob id belongs to another conversation'), { status: 409 })
      }
      return { duplicate: true }
    }
    this.db.prepare(`
      INSERT INTO blobs (blob_id, conv_id, sender, size, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(blobId, convId, sender, size, sha256, nowMs())
    return { duplicate: false }
  }

  getBlob(blobId) {
    return this.db.prepare('SELECT * FROM blobs WHERE blob_id = ?').get(blobId)
  }

  countBlobs(convId) {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM blobs WHERE conv_id = ?').get(convId)
    return Number(row?.count || 0)
  }

  putProfile({ deviceId, name, iconType = null, icon = null }) {
    this.db.prepare(`
      INSERT INTO profiles (device_id, name, icon_type, icon, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        name = excluded.name,
        icon_type = COALESCE(excluded.icon_type, profiles.icon_type),
        icon = COALESCE(excluded.icon, profiles.icon),
        updated_at = excluded.updated_at
    `).run(deviceId, name, iconType, icon, nowMs())
  }

  getProfile(deviceId) {
    return this.db.prepare('SELECT * FROM profiles WHERE device_id = ?').get(deviceId)
  }
}
