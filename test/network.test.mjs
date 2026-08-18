// dsh-video-lens network-layer tests: VLM/ASR client behavior under
// provider failures, odd response shapes, and timeouts. No real API keys —
// fetch is stubbed. ASR paths need ffmpeg to extract audio from a tiny
// synthetic clip.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chatWithVision, extractMessageContent, VlmHttpError } from '../src/vlm.js'
import { transcribe, AsrError } from '../src/asr.js'

const execFileAsync = promisify(execFile)
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Installs a fetch stub for one test; returns a restore function.
function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = original
  }
}

const BASE = 'https://mock.example/v1'
const KEY = 'sk-mock'
const EMPTY_FRAMES = []

// --- extractMessageContent: response shape compatibility ---
check('content as string', extractMessageContent({ content: 'hello' }) === 'hello')
check('content as part array', extractMessageContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'ab')
check('content as string parts', extractMessageContent({ content: ['x', 'y'] }) === 'xy')
check('content missing → undefined', extractMessageContent({}) === undefined)
check('content non-string object → undefined', extractMessageContent({ content: { nested: true } }) === undefined)

// --- chatWithVision: happy paths ---
{
  const restore = stubFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '{"ok":true}' }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  const text = await chatWithVision({ baseUrl: BASE, apiKey: KEY, model: 'm', prompt: 'p', frames: EMPTY_FRAMES })
  check('chatWithVision: content array accepted', text === '{"ok":true}', text)
  restore()
}

// --- chatWithVision: provider errors ---
for (const status of [401, 429, 500]) {
  const restore = stubFetch(async () => new Response('provider error body', { status }))
  try {
    await chatWithVision({ baseUrl: BASE, apiKey: KEY, model: 'm', prompt: 'p', frames: EMPTY_FRAMES })
    check(`chatWithVision: HTTP ${status} throws`, false, 'did not throw')
  } catch (err) {
    check(`chatWithVision: HTTP ${status} throws`, err instanceof VlmHttpError && err.status === status, err.message)
  }
  restore()
}

// --- chatWithVision: non-JSON response ---
{
  const restore = stubFetch(async () => new Response('this is not json', { status: 200 }))
  try {
    await chatWithVision({ baseUrl: BASE, apiKey: KEY, model: 'm', prompt: 'p', frames: EMPTY_FRAMES })
    check('chatWithVision: non-JSON throws', false, 'did not throw')
  } catch {
    check('chatWithVision: non-JSON throws', true)
  }
  restore()
}

// --- chatWithVision: empty content ---
{
  const restore = stubFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }))
  try {
    await chatWithVision({ baseUrl: BASE, apiKey: KEY, model: 'm', prompt: 'p', frames: EMPTY_FRAMES })
    check('chatWithVision: empty content throws', false, 'did not throw')
  } catch (err) {
    check('chatWithVision: empty content throws', /no content/.test(err.message))
  }
  restore()
}

// --- chatWithVision: abort propagation (manual controller; AbortSignal.timeout
// uses an unref'd timer that lets the event loop exit before firing in a
// top-level-await test context) ---
{
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('simulated timeout')), 150)
  const restore = stubFetch(
    (url, opts) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
      }),
  )
  try {
    await chatWithVision({ baseUrl: BASE, apiKey: KEY, model: 'm', prompt: 'p', frames: EMPTY_FRAMES, signal: controller.signal })
    check('chatWithVision: abort propagates', false, 'did not throw')
  } catch (err) {
    check('chatWithVision: abort propagates', /simulated timeout/.test(err.message), err.message)
  } finally {
    clearTimeout(timer)
    restore()
  }
}

// --- transcribe: provider errors, text-only, segments ---
const dir = await mkdtemp(join(tmpdir(), 'dsh-video-lens-net-'))
const WAV = join(dir, 'in.wav')
try {
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '16000', '-ac', '1', '-f', 'wav', WAV])
  process.env.VIDEO_LENS_ASR_KEY = 'sk-mock'

  // 500 → AsrError
  {
    const restore = stubFetch(async () => new Response('asr down', { status: 500 }))
    try {
      await transcribe(WAV, { asrBaseUrl: BASE, asrModel: 'm', asrApiKeyEnv: 'VIDEO_LENS_ASR_KEY' })
      check('transcribe: HTTP 500 throws', false, 'did not throw')
    } catch (err) {
      check('transcribe: HTTP 500 throws', err instanceof AsrError && err.status === 500, err.message)
    }
    restore()
  }

  // text-only response → one untimed segment
  {
    const restore = stubFetch(async () => new Response(JSON.stringify({ text: '你好世界' }), { status: 200 }))
    const t = await transcribe(WAV, { asrBaseUrl: BASE, asrModel: 'm', asrApiKeyEnv: 'VIDEO_LENS_ASR_KEY' })
    check('transcribe: text-only → single untimed segment', t.segments.length === 1 && t.segments[0].start === 0 && t.segments[0].end === null && t.segments[0].text === '你好世界', JSON.stringify(t.segments))
    restore()
  }

  // segmented response → parsed
  {
    const restore = stubFetch(async () => new Response(JSON.stringify({ text: 'ab', segments: [{ start: 0, end: 1.5, text: 'a' }, { start: 1.5, end: 3, text: 'b' }], language: 'zh' }), { status: 200 }))
    const t = await transcribe(WAV, { asrBaseUrl: BASE, asrModel: 'm', asrApiKeyEnv: 'VIDEO_LENS_ASR_KEY' })
    check('transcribe: segments parsed', t.segments.length === 2 && t.segments[1].end === 3 && t.language === 'zh', JSON.stringify(t.segments))
    restore()
  }

  // non-JSON body
  {
    const restore = stubFetch(async () => new Response('not json', { status: 200 }))
    try {
      await transcribe(WAV, { asrBaseUrl: BASE, asrModel: 'm', asrApiKeyEnv: 'VIDEO_LENS_ASR_KEY' })
      check('transcribe: non-JSON throws', false, 'did not throw')
    } catch {
      check('transcribe: non-JSON throws', true)
    }
    restore()
  }
} finally {
  delete process.env.VIDEO_LENS_ASR_KEY
  await rm(dir, { recursive: true, force: true })
}

const passed = results.filter((r) => r.ok).length
console.log(`\nRESULT: ${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
