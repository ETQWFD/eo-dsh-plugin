/**
 * `eo/` workspace archive.
 *
 * Layout:
 *   <workspace>/eo/index.json
 *   <workspace>/eo/<convId>/meta.json
 *   <workspace>/eo/<convId>/messages.jsonl
 *   <workspace>/eo/<convId>/attachments/...
 *
 * The local archive is plaintext so the DSH agent can read it with ordinary
 * file tools. Any copy that leaves the machine (GitHub archive) must be
 * encrypted by the archiver; the plugin never uploads plaintext.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isConvId } from './protocol.js'

function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, file)
}

function safeFileName(name) {
  const base = String(name || '').replace(/[\u0000-\u001f]/g, '')
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').trim()
  const bounded = cleaned.slice(0, 120) || 'file'
  return bounded.startsWith('.') ? `_${bounded}` : bounded
}

function assertConvId(convId) {
  if (!isConvId(convId)) throw new Error(`invalid convId: ${convId}`)
}

export class EoStore {
  constructor(workspaceDir) {
    this.workspaceDir = path.resolve(workspaceDir || process.cwd())
    this.root = path.join(this.workspaceDir, 'eo')
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  conversationDir(convId) {
    assertConvId(convId)
    return path.join(this.root, convId)
  }

  ensureConversation(conv) {
    assertConvId(conv.convId)
    const dir = this.conversationDir(conv.convId)
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true, mode: 0o700 })
    const metaFile = path.join(dir, 'meta.json')
    if (!fs.existsSync(metaFile)) {
      atomicWrite(metaFile, JSON.stringify({
        v: 1,
        convId: conv.convId,
        title: conv.title || 'EO助手',
        peerDeviceId: conv.peerDeviceId || '',
        createdAt: conv.createdAt || Date.now(),
        note: '本目录由 EO助手 插件写入；本地明文供 Agent 读取，离开本机前必须加密。',
      }, null, 2))
    }
    const logFile = path.join(dir, 'messages.jsonl')
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '', { mode: 0o600 })
    return dir
  }

  append(convId, record) {
    assertConvId(convId)
    const dir = this.conversationDir(convId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(path.join(dir, 'messages.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  readMessages(convId, limit = 100) {
    assertConvId(convId)
    const file = path.join(this.conversationDir(convId), 'messages.jsonl')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
  }

  writeIndex(conversations) {
    const rows = [...conversations.values()].map((c) => ({
      convId: c.convId,
      title: c.title,
      peerDeviceId: c.peerDeviceId,
      createdAt: c.createdAt,
      lastMessageAt: c.lastMessageAt ?? null,
    }))
    atomicWrite(path.join(this.root, 'index.json'), JSON.stringify({
      v: 1,
      updatedAt: Date.now(),
      conversations: rows,
    }, null, 2))
  }

  saveAttachment(convId, msgId, fileName, buffer) {
    assertConvId(convId)
    const dir = path.join(this.conversationDir(convId), 'attachments')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const name = `${safeFileName(msgId)}-${safeFileName(fileName)}`
    const file = path.join(dir, name)
    fs.writeFileSync(file, buffer, { mode: 0o600 })
    return path.relative(this.workspaceDir, file).split(path.sep).join('/')
  }

  settingsFile() {
    return path.join(this.root, 'settings.json')
  }

  readSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.settingsFile(), 'utf8'))
    } catch {
      return {}
    }
  }

  writeSettings(settings) {
    atomicWrite(this.settingsFile(), JSON.stringify({ v: 1, ...settings }, null, 2))
  }

  iconFile() {
    return path.join(this.root, 'icon')
  }
}

export { safeFileName, atomicWrite }
