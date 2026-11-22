/**
 * EO Assistant — DeepSeek Harness host plugin.
 *
 * Responsibilities:
 *   1. own the desktop device identity and relay WebSocket;
 *   2. expose a same-origin settings API for the QR bind page;
 *   3. map each bound phone to one DSH Session and drive its Agent;
 *   4. archive plaintext messages under <workspace>/eo/ for local Agent use.
 *
 * The plugin intentionally has no build step: plain ESM keeps `dsh plugin add`
 * deterministic and avoids requiring a TypeScript toolchain in the profile.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadIdentity } from './identity.js'
import { randomToken } from './protocol.js'
import { RelayClient } from './relay-client.js'
import { EoStore } from './store.js'
import { SessionBridge } from './bridge.js'
import { registerHttpApi } from './http-api.js'

export const name = 'eo-assistant'

const DEFAULTS = {
  assistantName: 'EO助手',
  relayUrl: '',
  workspaceDir: '',
  provider: '',
  model: '',
  maxFileMB: 50,
}

function log(...args) {
  console.log('[eo]', ...args)
}

function normalizeConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  return {
    assistantName: String(merged.assistantName || DEFAULTS.assistantName).slice(0, 32),
    relayUrl: String(merged.relayUrl || '').replace(/\/+$/, ''),
    workspaceDir: merged.workspaceDir ? path.resolve(String(merged.workspaceDir)) : '',
    provider: String(merged.provider || ''),
    model: String(merged.model || ''),
    maxFileMB: Number(merged.maxFileMB) > 0 ? Number(merged.maxFileMB) : DEFAULTS.maxFileMB,
  }
}

function loadConversations(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed.conversations)) return []
    return parsed.conversations
      .filter((row) => row && typeof row.convId === 'string' && typeof row.key === 'string')
      .map((row) => ({
        ...row,
        key: Buffer.from(row.key, 'base64'),
        online: false,
      }))
  } catch {
    return []
  }
}

function writeConversations(file, conversations) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const rows = [...conversations.values()].map((conv) => ({
    convId: conv.convId,
    title: conv.title,
    peerDeviceId: conv.peerDeviceId,
    peerEdPub: conv.peerEdPub,
    peerXPub: conv.peerXPub,
    key: Buffer.from(conv.key).toString('base64'),
    seq: conv.seq || 0,
    createdAt: conv.createdAt,
    lastMessageAt: conv.lastMessageAt ?? null,
  }))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, updatedAt: Date.now(), conversations: rows }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dataDir = path.join(home, 'eo')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  const identity = loadIdentity(dataDir)
  const store = new EoStore(config.workspaceDir || process.cwd())
  const conversationsFile = path.join(dataDir, 'conversations.json')
  const storedSettings = store.readSettings()

  const state = {
    token: randomToken(),
    connected: false,
    relayError: '',
    bind: null,
    conversations: new Map(loadConversations(conversationsFile).map((conv) => [conv.convId, conv])),
    settings: {
      assistantName: String(storedSettings.assistantName || config.assistantName),
      iconType: String(storedSettings.iconType || ''),
      iconVersion: Number(storedSettings.iconVersion || 0),
    },
  }

  const persist = () => {
    try { writeConversations(conversationsFile, state.conversations) } catch (error) {
      log(`persist conversations failed: ${error.message}`)
    }
    try { store.writeIndex(state.conversations) } catch (error) {
      log(`write eo/index.json failed: ${error.message}`)
    }
  }
  state.persist = persist
  persist()

  let bridge
  const profilePayload = () => {
    let iconBase64 = ''
    try {
      const file = store.iconFile()
      if (fs.existsSync(file)) iconBase64 = fs.readFileSync(file).toString('base64')
    } catch (error) {
      log(`read icon failed: ${error.message}`)
    }
    return { name: state.settings.assistantName, iconBase64 }
  }
  const relay = new RelayClient({
    config,
    identity,
    state,
    log,
    handlers: {
      onStatus: (connected, error) => {
        if (connected) {
          log(`relay connected as ${identity.deviceId}`)
          relay.publishProfile(profilePayload()).catch((publishError) => {
            log(`publish profile failed: ${publishError.message}`)
          })
        } else if (error) log(`relay status: ${error}`)
      },
      onBindClaimed: (bind) => log(`bind ${bind.bindId} claimed; confirmation code shown in settings`),
      onBindConfirmed: (conv) => {
        state.conversations.set(conv.convId, conv)
        try { store.ensureConversation(conv) } catch (error) { log(`ensure eo folder failed: ${error.message}`) }
        persist()
        relay.publishProfile(profilePayload()).catch((error) => log(`publish profile failed: ${error.message}`))
        log(`binding confirmed: ${conv.convId} (${conv.peerDeviceId})`)
        bridge.ensure(conv).catch((error) => log(`session bridge setup failed: ${error.message}`))
      },
      onMessage: (conv, payload) => {
        bridge.deliver(conv, payload).catch((error) => log(`deliver failed: ${error.message}`))
      },
      onOutbound: () => persist(),
      onSeq: () => persist(),
      onPresence: (conv, online) => {
        log(`presence ${conv.convId}: ${online ? 'online' : 'offline'}`)
      },
    },
  })

  bridge = new SessionBridge({
    ctx,
    config,
    store,
    state,
    log,
    downloadAttachment: (conv, meta) => relay.downloadAttachment(conv, meta, config.maxFileMB * 1024 * 1024),
    sendToPhone: (conv, text) => relay.sendText(conv, text),
  })

  // Suppress the generic auto-generated Config page: EO Assistant owns a
  // custom settings section with the QR flow.
  try {
    ctx.get('settings')?.configure?.({ auto: false })
  } catch (error) {
    log(`settings.configure skipped: ${error.message}`)
  }

  ctx.effect(() => {
    relay.start()
    return () => relay.stop()
  })

  // Wait for the host web server instead of reading ctx.webServer during
  // apply(): the service can activate after this plugin's fiber.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposeApi = registerHttpApi({
        web: webCtx.webServer,
        state,
        config,
        relay,
        store,
        identity,
        log,
      })
      return () => {
        disposeApi()
        bridge.dispose()
      }
    })
  })

  log(`loaded; device=${identity.deviceId}; workspace=${store.workspaceDir}`)
}
