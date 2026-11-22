/**
 * "EO助手连接" settings section.
 *
 * Plain React.createElement keeps the plugin build-free. The component talks to
 * the host through /eo/api/* on the same origin and never sees a private key.
 */
import React from 'react'

const h = React.createElement
const { useEffect, useRef, useState } = React

const API = '/eo/api'

const C = {
  text: 'var(--dsh-text-primary, #1f2328)',
  muted: 'var(--dsh-text-secondary, #656d76)',
  bg: 'var(--dsh-bg-secondary, #f6f8fa)',
  border: 'var(--dsh-border-default, #d0d7de)',
  accent: 'var(--dsh-accent, #0969da)',
  success: '#1a7f37',
  danger: '#cf222e',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}

function card(children) {
  return h('div', {
    style: {
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: 16,
      marginBottom: 14,
      background: 'var(--dsh-bg-primary, #ffffff)',
      color: C.text,
      fontSize: 14,
    },
  }, children)
}

function label(text) {
  return h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 8 } }, text)
}

function button(text, onClick, options = {}) {
  return h('button', {
    type: 'button',
    onClick,
    disabled: options.disabled,
    style: {
      appearance: 'none',
      border: `1px solid ${options.primary ? C.accent : C.border}`,
      background: options.primary ? C.accent : 'transparent',
      color: options.primary ? '#ffffff' : C.text,
      borderRadius: 6,
      padding: '6px 12px',
      fontSize: 13,
      cursor: options.disabled ? 'not-allowed' : 'pointer',
      opacity: options.disabled ? 0.55 : 1,
      marginRight: 8,
    },
  }, text)
}

function dot(online) {
  return h('span', {
    style: {
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: 4,
      background: online ? C.success : C.muted,
      marginRight: 6,
      verticalAlign: 'middle',
    },
  })
}

function badge(text, tone) {
  const colors = { ok: C.success, warn: '#9a6700', bad: C.danger, neutral: C.muted }
  return h('span', {
    style: {
      display: 'inline-block',
      border: `1px solid ${colors[tone] || C.muted}`,
      color: colors[tone] || C.muted,
      borderRadius: 999,
      padding: '2px 8px',
      fontSize: 12,
      marginRight: 8,
    },
  }, text)
}

async function readJson(response) {
  const text = await response.text()
  try { return text ? JSON.parse(text) : {} } catch { return { error: text.slice(0, 200) } }
}

export function EoConnectSection() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [nameReady, setNameReady] = useState(false)
  const alive = useRef(true)

  const refresh = async () => {
    try {
      const response = await fetch(`${API}/state`, { cache: 'no-store', credentials: 'same-origin' })
      const json = await readJson(response)
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`)
      if (!alive.current) return
      setData(json)
      setError('')
      if (!nameReady) {
        setName(json.assistantName || '')
        setNameReady(true)
      }
    } catch (err) {
      if (!alive.current) return
      setError(err && err.message ? err.message : String(err))
    }
  }

  useEffect(() => {
    alive.current = true
    refresh()
    const timer = setInterval(refresh, 1500)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [])

  const post = async (path, body) => {
    if (!data?.token) {
      setError('设置接口尚未就绪，请稍后重试')
      return null
    }
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-eo-token': data.token },
        body: JSON.stringify(body || {}),
      })
      const json = await readJson(response)
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`)
      await refresh()
      return json
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
      return null
    } finally {
      setBusy(false)
    }
  }

  if (error && !data) {
    return card([
      label('EO助手连接'),
      h('div', { style: { color: C.danger, marginBottom: 8 } }, '无法访问插件设置接口'),
      h('div', { style: { color: C.muted, fontSize: 13, lineHeight: 1.6 } }, error),
      h('div', { style: { color: C.muted, fontSize: 13, lineHeight: 1.6, marginTop: 8 } },
        '请确认：1) 插件在 DSH 中已启用；2) 当前是 DSH Web 设置页；3) Desktop 端已更新到包含本插件的版本。'),
    ])
  }

  if (!data) return card([label('EO助手连接'), h('div', { style: { color: C.muted } }, '正在读取连接状态…')])

  const bind = data.bind
  const remain = bind ? Math.max(0, Math.ceil((bind.expiresAt - Date.now()) / 1000)) : 0
  const conversationLength = data.conversations.length

  const statusRow = h('div', { style: { marginBottom: 12 } }, [
    badge(data.connected ? 'relay 在线' : 'relay 离线', data.connected ? 'ok' : 'bad'),
    badge(data.relayKind === 'embedded' ? '内置 relay' : '外部 relay', 'neutral'),
    badge(conversationLength ? `${conversationLength} 个助手` : '未绑定', conversationLength ? 'ok' : 'neutral'),
    h('span', { style: { color: C.muted, fontSize: 12, fontFamily: C.mono } }, data.deviceId),
  ])

  const identityCard = card([
    label('助手信息'),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 } }, [
      data.hasIcon
        ? h('img', {
            src: `${API}/icon?v=${data.iconVersion}`,
            alt: '助手图标',
            style: { width: 48, height: 48, borderRadius: 10, objectFit: 'cover', border: `1px solid ${C.border}` },
          })
        : h('div', {
            style: {
              width: 48, height: 48, borderRadius: 10, background: C.bg,
              border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 18, color: C.muted,
            },
          }, 'EO'),
      h('div', { style: { flex: 1 } }, [
        h('div', { style: { color: C.muted, fontSize: 12, marginBottom: 4 } }, '连接助手名称'),
        h('input', {
          value: name,
          maxLength: 32,
          onChange: (event) => setName(event.target.value),
          style: {
            width: '100%', boxSizing: 'border-box', padding: '6px 10px',
            border: `1px solid ${C.border}`, borderRadius: 6,
            background: 'var(--dsh-bg-primary, #ffffff)', color: C.text, fontSize: 13,
          },
        }),
      ]),
    ]),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } }, [
      button('保存名称', () => post('/settings', { assistantName: name }), {
        primary: true,
        disabled: busy || !name.trim() || name.trim() === data.assistantName,
      }),
      h('label', {
        style: {
          display: 'inline-block', padding: '5px 10px', border: `1px solid ${C.border}`,
          borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.text,
        },
      }, [
        '选择本地图标',
        h('input', {
          type: 'file',
          accept: 'image/png,image/jpeg',
          style: { display: 'none' },
          onChange: (event) => {
            const file = event.target.files && event.target.files[0]
            if (!file) return
            if (file.size > 512 * 1024) {
              setError('图标不能超过 512KB')
              return
            }
            const reader = new FileReader()
            reader.onload = () => { post('/icon', { dataUrl: String(reader.result) }) }
            reader.onerror = () => setError('读取本地图标失败')
            reader.readAsDataURL(file)
          },
        }),
      ]),
      h('span', { style: { color: C.muted, fontSize: 12 } }, 'PNG/JPEG，≤512KB'),
    ]),
  ])

  let bindBody
  if (!data.relayUrl) {
    bindBody = h('div', { style: { color: C.muted, lineHeight: 1.7 } }, [
      h('div', { style: { color: data.relayError ? C.danger : C.muted, marginBottom: 10 } },
        data.relayError || '正在启动内置 relay…稍等几秒后刷新。'),
      button('重试', () => post('/bind/new'), { disabled: busy }),
    ])
  } else if (!bind) {
    bindBody = h('div', null, [
      h('div', { style: { color: C.muted, marginBottom: 10, lineHeight: 1.7 } },
        '点击生成二维码，用手机 EO助手 右上角“扫一扫”绑定这台电脑。手机和电脑在同一 Wi-Fi 下即可，无需填写 relay 地址；二维码 120 秒内有效。'),
      button(busy ? '生成中…' : '生成二维码', () => post('/bind/new'), { primary: true, disabled: busy }),
    ])
  } else if (bind.status === 'confirmed') {
    bindBody = h('div', null, [
      h('div', { style: { color: C.success, fontWeight: 600, marginBottom: 8 } }, '已连接'),
      h('div', { style: { color: C.muted, lineHeight: 1.7, marginBottom: 10 } },
        '手机端已绑定。现在可以在手机上向该助手发送消息，消息会进入对应的 DSH 会话并归档到 eo/ 目录。'),
      button('再绑定一台手机', () => post('/bind/new'), { primary: true, disabled: busy }),
    ])
  } else {
    const expired = remain <= 0
    bindBody = h('div', { style: { textAlign: 'center' } }, [
      expired
        ? h('div', { style: { color: C.danger, padding: '40px 0' } }, '二维码已过期，请重新生成')
        : h('img', {
            src: bind.qrDataUrl,
            alt: 'EO助手绑定二维码',
            width: 240,
            height: 240,
            style: { display: 'block', margin: '0 auto 10px', background: '#fff', padding: 8, borderRadius: 8 },
          }),
      h('div', { style: { color: C.muted, fontSize: 12, marginBottom: 10 } },
        expired ? '' : `有效期剩余 ${remain} 秒`),
      bind.status === 'claimed' && bind.code
        ? h('div', { style: { margin: '10px 0 14px' } }, [
            h('div', { style: { color: C.muted, fontSize: 12, marginBottom: 6 } }, '请在手机上输入以下 6 位确认码'),
            h('div', {
              style: {
                fontFamily: C.mono, fontSize: 28, letterSpacing: 6,
                fontWeight: 700, color: C.text,
              },
            }, String(bind.code)),
          ])
        : null,
      h('div', null, [
        button(expired ? '重新生成' : '刷新二维码', () => post('/bind/new'), { primary: true, disabled: busy }),
        button('取消', () => post('/bind/cancel'), { disabled: busy }),
      ]),
    ])
  }

  const bindCard = card([label('扫码绑定'), statusRow, bindBody])

  const conversations = Array.isArray(data.conversations) ? data.conversations : []
  const conversationRows = conversations.length
    ? conversations.map((conv) => h('div', {
        key: conv.convId,
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 0', borderTop: `1px solid ${C.border}`,
        },
      }, [
        h('div', null, [
          h('div', { style: { fontWeight: 600 } }, [dot(conv.online), conv.title || 'EO助手']),
          h('div', { style: { color: C.muted, fontSize: 12, fontFamily: C.mono } },
            `${conv.convId} · ${conv.peerDeviceId}`),
        ]),
        button('移除绑定', () => post('/unbind', { convId: conv.convId }), { disabled: busy }),
      ]))
    : [h('div', { style: { color: C.muted } }, '还没有绑定手机。')]

  const conversationsCard = card([label('已连接的助手'), ...conversationRows])

  const diagnostics = h('details', { style: { marginTop: 4, color: C.muted, fontSize: 12 } }, [
    h('summary', { style: { cursor: 'pointer' } }, '诊断信息'),
    h('div', { style: { marginTop: 8, fontFamily: C.mono, lineHeight: 1.7, wordBreak: 'break-all' } }, [
      h('div', null, `relay: ${data.relayUrl || '(启动中)'}`),
      h('div', null, `relay kind: ${data.relayKind || 'embedded'}`),
      h('div', null, `connected: ${String(data.connected)}`),
      h('div', null, `error: ${data.relayError || '(无)'}`),
      h('div', null, `device: ${data.deviceId}`),
    ]),
  ])

  return h('div', null, [
    error ? h('div', {
      style: {
        border: `1px solid ${C.danger}`, color: C.danger, borderRadius: 8,
        padding: '8px 12px', marginBottom: 12, fontSize: 13,
      },
    }, error) : null,
    identityCard,
    bindCard,
    conversationsCard,
    diagnostics,
  ])
}
