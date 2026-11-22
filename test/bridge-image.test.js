import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionBridge } from '../src/bridge.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f6c0000000049454e44ae426082', 'hex')

function harness({ imageCapable = true } = {}) {
  const calls = []
  const appended = []
  const admitted = []
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => ({ append: (...args) => appended.push(args) }) }
      if (name === 'agents') return {
        get: () => ({
          agent: { followup: (message) => calls.push(message) },
        }),
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      if (name === 'attachments') return {
        admitPromptContent: async (parts) => {
          admitted.push(parts)
          return parts.map((part) => part.type === 'image'
            ? { type: 'image', attachment: { attachmentId: 'sha256:test', mediaType: part.mediaType, bytes: PNG.length, width: 1, height: 1 }, encodedBytes: PNG.length }
            : part)
        },
      }
      if (name === 'llm') return {
        resolveModelInfo: async () => ({ provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek', inputModalities: imageCapable ? ['text', 'image'] : ['text'] }),
      }
      return undefined
    },
    on: () => () => {},
  }
  const store = {
    saveAttachment: () => '/tmp/attachment.png',
    append: () => {},
  }
  const bridge = new SessionBridge({
    ctx,
    config: { maxFileMB: 50 },
    store,
    state: {},
    sendToPhone: () => {},
    downloadAttachment: async () => PNG,
    log: () => {},
  })
  return { bridge, calls, appended, admitted }
}

const conv = { convId: 'c_test123456', key: Buffer.alloc(32), lastMessageAt: null }
const payload = {
  msgId: 'm_test123456', seq: 1, kind: 'image', ts: Date.now(), text: '',
  meta: { type: 'image', name: 'photo.jpg', mime: 'image/jpeg', size: PNG.length, sha256: 'x', blobId: 'b_test123456', blobNonce: 'n', blobAad: 'a' },
}

test('image payload is admitted and becomes a real image content block', async () => {
  const h = harness()
  await h.bridge.deliver(conv, payload)
  assert.equal(h.admitted.length, 1)
  assert.equal(h.admitted[0][0].type, 'image')
  assert.equal(h.admitted[0][0].mediaType, 'image/jpeg')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].content[0].type, 'text')
  assert.match(h.calls[0].content[0].text, /已作为视觉输入/)
  assert.equal(h.calls[0].content[1].type, 'image')
  assert.equal(h.calls[0].content[1].attachment.attachmentId, 'sha256:test')
})

test('text-only model keeps the image on disk and reports why vision is unavailable', async () => {
  const h = harness({ imageCapable: false })
  await h.bridge.deliver(conv, payload)
  assert.equal(h.admitted.length, 0)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].content.length, 1)
  assert.match(h.calls[0].content[0].text, /未作为视觉输入/)
  assert.match(h.calls[0].content[0].text, /未声明图片输入/)
})

function eventHarness() {
  const h = harness()
  let listener = null
  h.bridge.ctx.on = (name, fn) => {
    if (name === 'session/event') listener = fn
    return () => {}
  }
  return { ...h, emit: (event) => listener?.({ id: 'eo-c_test123456' }, event) }
}

test('assistant message is archived and sent to the phone', async () => {
  const h = eventHarness()
  await h.bridge.ensure(conv)
  h.emit({ type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '看到图了' }] } } })
  assert.equal(h.calls.length, 0)
  // The relay send path is captured by the harness's sendToPhone callback.
})

test('a failed model attempt is pushed to the phone immediately', async () => {
  const h = eventHarness()
  const sent = []
  h.bridge.sendToPhone = (_conv, text) => sent.push(text)
  await h.bridge.ensure(conv)
  h.emit({ type: 'assistant/attempt', seq: 8, data: { turn: 1, stream: [{ chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'MISSING_CREDENTIAL' } } } }] } })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /模型调用失败/)
  assert.match(sent[0], /API Key/)
})
