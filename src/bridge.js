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
    this.failedTurns = new Set()
    this.disposed = false
  }

  services() {
    return {
      sessions: this.ctx.get('sessions'),
      agents: this.ctx.get('agents'),
      defaultModel: this.ctx.get('agentDefaultModel'),
      attachments: this.ctx.get('attachments'),
      llm: this.ctx.get('llm'),
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

  /** Match the incoming attachment to the media types DSH can actually store. */
  imageMime(meta) {
    const declared = String(meta?.mime || '').toLowerCase()
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(declared)) return declared
    const name = String(meta?.name || '').toLowerCase()
    if (name.endsWith('.png')) return 'image/png'
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
    if (name.endsWith('.webp')) return 'image/webp'
    if (name.endsWith('.gif')) return 'image/gif'
    return ''
  }

  async imageAdmission(meta, bytes) {
    if (!bytes?.length) return { block: null, reason: '图片下载失败' }
    const mime = this.imageMime(meta)
    if (!mime) return { block: null, reason: `图片格式 ${meta?.mime || '未知'} 暂不支持` }
    const selection = this.modelSelection()
    const { attachments, llm } = this.services()
    if (!attachments?.admitPromptContent) {
      return { block: null, reason: '当前 DSH profile 没有附件服务，无法把图片送入模型' }
    }
    if (llm?.resolveModelInfo && selection) {
      try {
        const info = await llm.resolveModelInfo(selection.provider, selection.model)
        if (Array.isArray(info?.inputModalities) && !info.inputModalities.includes('image')) {
          return {
            block: null,
            reason: `当前模型 ${selection.model} 未声明图片输入，请切换到 deepseek-flash 等视觉模型`,
          }
        }
      } catch (error) {
        // Model lookup is advisory here; admission below is the real gate.
        this.log(`[eo] image model lookup failed: ${error.message}`)
      }
    }
    try {
      const admitted = await attachments.admitPromptContent([{
        type: 'image',
        mediaType: mime,
        data: bytes.toString('base64'),
        name: String(meta?.name || 'image').slice(0, 128),
      }])
      const block = admitted.find((part) => part?.type === 'image')
      if (!block) return { block: null, reason: '附件服务没有返回图片引用' }
      return { block, reason: '' }
    } catch (error) {
      this.log(`[eo] image admission failed: ${error.message}`)
      return { block: null, reason: `图片准入失败：${error.message}` }
    }
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
      this.notifyError(conv, '⚠️ 这台电脑的 DSH 还没有可用模型。\n\n请在电脑 DSH「设置 → 模型」登录或添加 API Key，然后重新发送。', `err_model_${conv.convId}`)
    }

    const off = this.ctx.on('session/event', (eventSession, event) => {
      if (eventSession?.id !== sessionId) return
      if (event.type === 'assistant/attempt') {
        const failure = (event.data?.stream || [])
          .map((part) => part?.chunk?.reason?.failure)
          .find(Boolean)
        if (failure) {
          const turn = String(event.data?.turn ?? 0)
          const key = `${conv.convId}:${turn}`
          if (!this.failedTurns.has(key)) {
            this.failedTurns.add(key)
            const detail = String(failure.message || failure.code || '未知错误').slice(0, 700)
            this.notifyError(conv, `⚠️ 模型调用失败：${detail}\n\n请在电脑 DSH「设置 → 模型」登录或添加 API Key，检查模型与网络后重试。`, `err_turn_${turn}_${event.seq ?? 0}`)
          }
        }
        return
      }
      if (event.type === 'turn/end') {
        const reason = event.data?.reason
        const turn = String(event.data?.turn ?? 0)
        if (reason?.kind === 'error') {
          const key = `${conv.convId}:${turn}`
          if (!this.failedTurns.has(key)) {
            this.failedTurns.add(key)
            const detail = String(reason.error?.message || reason.error || '未知错误').slice(0, 700)
            this.notifyError(conv, `⚠️ 模型调用失败：${detail}\n\n请在电脑 DSH「设置 → 模型」登录或添加 API Key，确认模型可用后再发送。`, `err_${turn}_${event.seq ?? 0}`)
          }
        }
        this.failedTurns.delete(`${conv.convId}:${turn}`)
        return
      }
      if (event.type !== 'assistant/message') return
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return
      const text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
        .trim()
      if (!text) return
      this.pushAssistant(conv, text, `a_${event.seq ?? 0}`, Number(event.seq ?? 0))
    })

    const entry = { conv, session, handle, off }
    this.entries.set(conv.convId, entry)
    // If no Agent could be attached (missing model/credentials), do not
    // permanently cache a dead entry: the user may add a model later, and the
    // next phone message should retry instead of silently archiving forever.
    if (!handle) {
      try { off() } catch { /* ignore */ }
      this.entries.delete(conv.convId)
    }
    return entry
  }

  notifyError(conv, text, msgId = `err_${Date.now()}`) {
    this.log(`[eo] ${text.split('\n')[0]}`)
    this.pushAssistant(conv, text, msgId, 0, true)
  }

  pushAssistant(conv, text, msgId, seq, isError = false) {
    const record = {
      msgId,
      seq,
      sender: 'assistant',
      kind: 'text',
      ts: Date.now(),
      text,
      ...(isError ? { error: true } : {}),
    }
    try { this.store.append(conv.convId, record) } catch (error) {
      this.log(`[eo] archive assistant message failed: ${error.message}`)
    }
    conv.lastMessageAt = record.ts
    try { this.sendToPhone(conv, text) } catch (error) {
      this.log(`[eo] send assistant message failed: ${error.message}`)
    }
  }

  async deliver(conv, payload) {
    let meta = payload.meta && typeof payload.meta === 'object' ? { ...payload.meta } : null
    let attachmentPath = ''
    let attachmentError = ''
    let attachmentBytes = null
    if (meta?.blobId) {
      try {
        if (typeof this.downloadAttachment !== 'function') throw new Error('attachment transport unavailable')
        const bytes = await this.downloadAttachment(conv, meta)
        attachmentBytes = bytes
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

    const isImage = payload.kind === 'image' || meta?.type === 'image'
    const label = payload.kind === 'voice' ? '语音'
      : payload.kind === 'ppt' ? 'PPT'
        : isImage ? '图片' : '文件'
    let text = payload.text || ''
    let image = { block: null, reason: '' }
    if (meta?.blobId) {
      const size = Number(meta.size || meta.bytes || 0)
      const sizeText = size > 0 ? `，${(size / 1024).toFixed(1)}KB` : ''
      const place = attachmentPath
        ? `已保存到 ${attachmentPath}`
        : `未能下载（${attachmentError || '未知错误'}），blobId=${meta.blobId}`
      if (isImage && attachmentBytes?.length) {
        image = await this.imageAdmission(meta, attachmentBytes)
      }
      const vision = isImage && image.block
        ? '；已作为视觉输入发送给模型'
        : isImage && image.reason
          ? `；未作为视觉输入：${image.reason}`
          : ''
      text = [
        text,
        `[${label}] ${meta.name || '未命名'}${sizeText}；${place}${vision}`,
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

    const content = image.block
      ? [{ type: 'text', text }, image.block]
      : [{ type: 'text', text }]
    if (entry.handle?.agent?.followup) {
      try {
        entry.handle.agent.followup({ role: 'user', content, source: { kind: 'eo' } })
      } catch (error) {
        this.log(`[eo] agent followup failed: ${error.message}`)
        this.notifyError(conv, `⚠️ 无法启动模型：${error.message}`, `err_followup_${payload.msgId}`)
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
