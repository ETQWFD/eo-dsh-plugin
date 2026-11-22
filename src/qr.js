/**
 * QR rendering. The SVG is returned as a data URL and rendered by the settings
 * page inside an <img>, never injected as markup, so SVG cannot execute code.
 */
import QRCode from 'qrcode'

export async function makeQrDataUrl(text, size = 280) {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: size,
    color: { dark: '#111827', light: '#ffffff' },
  })
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

export function buildBindPayload({ relayUrl, bindId, desktopXPub, nonce, fingerprint, assistantName }) {
  const params = new URLSearchParams({
    v: '1',
    r: relayUrl,
    b: bindId,
    x: desktopXPub,
    n: nonce,
    f: fingerprint,
    name: assistantName || 'EO助手',
  })
  return `eo://bind?${params.toString()}`
}
