// OpenAI-compatible ASR client (audio/transcriptions).
//
// Same philosophy as vlm.js: one protocol, many providers. SiliconFlow,
// DashScope (compatible mode), OpenAI, Groq, any vLLM/whisper server, etc.
// Returns timestamped segments; returns null (caller keeps the visual path)
// when no API key is configured, so ASR is strictly additive.
import { readFile, rm } from 'node:fs/promises'
import { extractAudio } from './frames.js'

const ASR_TIMEOUT_MS = 120_000

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

export class AsrError extends Error {
  constructor(status, body) {
    super(`ASR HTTP ${status}: ${body.slice(0, 500)}`)
    this.status = status
  }
}

// Transcribes `videoPath` via an OpenAI-compatible /audio/transcriptions
// endpoint. Resolves null when the key env var is unset. Throws on transport
// or provider errors (callers may degrade).
export async function transcribe(
  videoPath,
  {
    asrBaseUrl,
    asrModel,
    asrApiKeyEnv,
    timeoutMs = ASR_TIMEOUT_MS,
    signal,
  },
) {
  const apiKey = process.env[asrApiKeyEnv]
  if (!apiKey) return null

  const { wavPath, dir } = await extractAudio({ videoPath, signal })
  try {
    const blob = new Blob([await readFile(wavPath)], { type: 'audio/wav' })
    const form = new FormData()
    form.append('file', blob, 'audio.wav')
    form.append('model', asrModel)
    form.append('response_format', 'verbose_json')

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    const res = await fetch(joinUrl(asrBaseUrl, '/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: signalAll,
    })
    if (!res.ok) {
      throw new AsrError(res.status, await res.text().catch(() => ''))
    }

    const body = await res.json()
    let segments = Array.isArray(body.segments)
      ? body.segments
          .map((s) => ({
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: (s.text ?? '').trim(),
          }))
          .filter((s) => s.text.length > 0)
      : []
    const text =
      typeof body.text === 'string' && body.text.length > 0
        ? body.text
        : segments.map((s) => s.text).join(' ')

    if (segments.length === 0 && text.length > 0) {
      // Providers that return plain `{ text }` without segments (e.g.
      // SiliconFlow SenseVoiceSmall) get one untimed segment so downstream
      // keyword matching and prompting still work. `end: null` signals
      // "untimed" to callers, which may substitute the video duration.
      segments = [{ start: 0, end: null, text }]
    }

    return { text, segments, language: body.language }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
