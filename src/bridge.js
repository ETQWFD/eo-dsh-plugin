/**
 * Bridge between an EO conversation and a DSH Session/Agent.
 *
 * One bound phone = one conversation = one DSH Session (`eo-<convId>`).
 * Incoming phone messages are queued through Agent.followup(); assistant
 * messages are read back from the session event stream and sent to the phone.
 *
 * The plugin deliberately does not dispose Agent handles on unload: a handle
 * owns its Session and disposing it would delete the user's conversation.
 * DSH's own lifetime management owns that decision.
 */
export class SessionBridge {
  constructor({ ctx, config, store, state, sendToPhone, downloadAttachment, log = console.log }) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.state = state
    this.sendToPhone = sendToPhone
    this.downloadAttachment = downloadAttachment
    this.log = log
    this.entries = new Map()
    this.disposed = false
  }

  services() {
    return {
      sessions: this.ctx.get('sessions'),
      agents: this.ctx.get('agents'),
      defaultModel: this.ctx.get('agentDefaultModel'),
    }
  }

  sessionId(conv) {
    return `eo-${conv.convId}`
  }

  modelSelection() {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model }
    }
    try {
      const selection = this.services().defaultModel?.currentSelection?.()
      if (selection?.provider && selection?.model) return selection
    } catch {
      // fall through to the diagnostic below
    }
    return null
  }

  async ensure(conv) {
    if (this.disposed) return null
    const existing = this.entries.get(conv.convId)
    if (existing) return existing

    const { sessions, agents } = this.services()
    if (!sessions?.get && !sessions?.create) {
      this.log('[eo] DSH sessions service is unavailable; messages will be archived but not bridged')
      return null
    }

    const sessionId = this.sessionId(conv)
    const cwd = this.config.workspaceDir || process.cwd()
    const selection = this.modelSelection()
    const agentOptions = selection ? { provider: selection.provider, model: selection.model } : undefined

    let session = sessions?.get?.(sessionId) ?? null
    let handle = null
    try {
      handle = agents?.get?.(sessionId) ?? null
      if (!handle && agents?.create) {
        if (session) {
          // A persisted EO session may exist after a DSH restart. `create()`
          // rejects an existing session id, so resume instead of recreating.
          if (typeof agents.resume === 'function') {
            handle = await agents.resume({ resumeSessionId: sessionId, agentOptions })
          }
        } else {
          handle = await agents.create({ sessionId, meta: { cwd }, agentOptions })
          session = sessions?.get?.(sessionId) ?? session
        }
      }
    } catch (error) {
      this.log(`[eo] cannot attach agent for ${sessionId}: ${error.message}`)
    }

    if (!session) {
      try {
        session = sessions.create(sessionId, { meta: { cwd } })
      } catch (error) {
        this.log(`[eo] cannot create session ${sessionId}: ${error.message}`)
        return null
      }
    }

    if (!handle && !selection) {
      this.log('[eo] no default model selection; messages are archived and appended to the session without an agent reply')
    }

    const off = this.ctx.on('session/event', (eventSession, event) => {
      if (eventSession?.id !== sessionId) return
      if (event.type !== 'assistant/message') return
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return
      const text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
        .trim()
      if (!text) return
      const record = {
        msgId: `a_${event.seq ?? 0}`,
        seq: Number(event.seq ?? 0),
        sender: 'assistant',
        kind: 'text',
        ts: Date.now(),
        text,
      }
      try { this.store.append(conv.convId, record) } catch (error) {
        this.log(`[eo] archive assistant message failed: ${error.message}`)
      }
      conv.lastMessageAt = record.ts
      try { this.sendToPhone(conv, text) } catch (error) {
        this.log(`[eo] send assistant message failed: ${error.message}`)
      }
    })

    const entry = { conv, session, handle, off }
    this.entries.set(conv.convId, entry)
    return entry
  }

  async deliver(conv, payload) {
    let meta = payload.meta && typeof payload.meta === 'object' ? { ...payload.meta } : null
    let attachmentPath = ''
    let attachmentError = ''
    if (meta?.blobId) {
      try {
        if (typeof this.downloadAttachment !== 'function') throw new Error('attachment transport unavailable')
        const bytes = await this.downloadAttachment(conv, meta)
        attachmentPath = this.store.saveAttachment(
          conv.convId,
          payload.msgId,
          meta.name || (payload.kind === 'voice' ? 'voice.webm' : 'attachment'),
          bytes,
        )
        meta.localPath = attachmentPath
        meta.bytes = bytes.length
      } catch (error) {
        attachmentError = error.message || String(error)
        this.log(`[eo] attachment download failed: ${attachmentError}`)
      }
    }

    const label = payload.kind === 'voice' ? '语音' : payload.kind === 'ppt' ? 'PPT' : '文件'
    let text = payload.text || ''
    if (meta?.blobId) {
      const size = Number(meta.size || meta.bytes || 0)
      const sizeText = size > 0 ? `，${(size / 1024).toFixed(1)}KB` : ''
      const place = attachmentPath
        ? `已保存到 ${attachmentPath}`
        : `未能下载（${attachmentError || '未知错误'}），blobId=${meta.blobId}`
      text = [
        text,
        `[${label}] ${meta.name || '未命名'}${sizeText}；${place}`,
      ].filter(Boolean).join('\n')
    }

    const record = {
      msgId: payload.msgId,
      seq: payload.seq,
      sender: 'phone',
      kind: payload.kind || 'text',
      ts: payload.ts || Date.now(),
      text: payload.text || '',
      meta,
    }
    try { this.store.append(conv.convId, record) } catch (error) {
      this.log(`[eo] archive phone message failed: ${error.message}`)
    }
    conv.lastMessageAt = record.ts

    const entry = await this.ensure(conv)
    if (!entry) return

    const content = [{ type: 'text', text }]
    if (entry.handle?.agent?.followup) {
      try {
        entry.handle.agent.followup({ content, source: { kind: 'eo' } })
      } catch (error) {
        this.log(`[eo] agent followup failed: ${error.message}`)
      }
      return
    }

    // No agent available: still record the user turn so the desktop user can
    // see it in the session and continue manually.
    try {
      entry.session.append('user/message', {
        role: 'user',
        content,
        source: { kind: 'eo' },
      }, { surfaceOp: 'append' })
    } catch (error) {
      this.log(`[eo] session append failed: ${error.message}`)
    }
  }

  dispose() {
    this.disposed = true
    for (const entry of this.entries.values()) {
      try { entry.off() } catch { /* ignore */ }
    }
    this.entries.clear()
  }
}
