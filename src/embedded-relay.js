/**
 * Embedded relay for the zero-config path.
 *
 * A DSH profile can own its relay instead of asking the user to deploy one:
 * the plugin starts the same signed/E2EE relay on an ephemeral LAN port,
 * serves the bundled PWA, and puts that URL into the bind QR. An explicit
 * `relayUrl` config still wins for users who deploy a public relay.
 */
import os from 'node:os'
import path from 'node:path'
import { createRelay } from './relay/server.js'

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254)
}

/** Best-effort LAN address for the QR; loopback only when no interface exists. */
export function lanAddress() {
  if (process.env.EO_RELAY_HOST) return process.env.EO_RELAY_HOST
  const interfaces = os.networkInterfaces()
  let fallback = ''
  for (const rows of Object.values(interfaces)) {
    for (const row of rows || []) {
      if (row.family !== 'IPv4' || row.internal) continue
      if (row.address.startsWith('169.254.')) continue
      if (isPrivateIPv4(row.address)) return row.address
      if (!fallback) fallback = row.address
    }
  }
  return fallback || '127.0.0.1'
}

export async function startEmbeddedRelay({ dataDir, publicDir, port = 8787, log = console.log }) {
  let lastError
  for (const candidate of [port, 0]) {
    const relay = createRelay({
      port: candidate,
      host: '0.0.0.0',
      dataFile: path.join(dataDir, 'relay.sqlite'),
      publicDir,
      corsOrigins: '*',
      maxBlobBytes: 17 * 1024 * 1024,
    })
    try {
      const address = await relay.start()
      const host = lanAddress()
      const url = `http://${host}:${address.port}`
      log(`embedded relay listening on ${url}`)
      return { relay, url, port: address.port, host }
    } catch (error) {
      lastError = error
      await relay.close().catch(() => {})
      if (candidate === 0) break
      log(`embedded relay port ${candidate} unavailable, falling back to an ephemeral port: ${error.message}`)
    }
  }
  throw new Error(`cannot start embedded relay: ${lastError?.message || 'unknown error'}`)
}
