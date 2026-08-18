// OpenAI-compatible vision-model client.
//
// One protocol, many providers: SiliconFlow, DashScope (compatible mode),
// Gemini (OpenAI-compat endpoint), Moonshot, any vLLM/Ollama server, etc.
// The plugin never ships a provider lock-in; baseUrl + model + key env are
// all user config.
const DEFAULT_TIMEOUT_MS = 90_000

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function stripJsonFences(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1] : trimmed
}

export class VlmHttpError extends Error {
  constructor(status, body) {
    super(`vision model HTTP ${status}: ${body.slice(0, 500)}`)
    this.status = status
  }
}

// Sends all frames in one chat-completions request and returns the raw
// response text. Cancellation flows through `signal`.
export async function chatWithVision({
  baseUrl,
  apiKey,
  model,
  prompt,
  frames,
  maxTokens = 1500,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}) {
  const content = [{ type: 'text', text: prompt }]
  for (const frame of frames) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${frame.base64}` },
    })
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signalAll = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  const res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
      temperature: 0,
    }),
    signal: signalAll,
  })

  if (!res.ok) {
    throw new VlmHttpError(res.status, await res.text().catch(() => ''))
  }

  const body = await res.json()
  const text = body?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`vision model returned no content: ${JSON.stringify(body).slice(0, 500)}`)
  }
  return text
}

// Parses the VLM's analysis, tolerating markdown fences. Falls back to the
// raw text so evidence is never lost to formatting quirks.
export function parseAnalysis(text) {
  try {
    return { analysis: JSON.parse(stripJsonFences(text)) }
  } catch {
    return { analysisRaw: text }
  }
}

// Token guard for transcript excerpts fed to the VLM.
const TRANSCRIPT_CHAR_BUDGET = 6000

// Builds the question-answering prompt for `video_ask`. `matchedSegments`
// are the transcript hits (already scored/sorted), `transcriptAvailable`
// tells the VLM whether speech exists at all so it can calibrate confidence.
export function buildAskPrompt({
  metadata,
  frames,
  question,
  matchedSegments = [],
  transcriptAvailable = false,
}) {
  const timestamps = frames.map((f) => `${f.timestampSec}s`).join(', ')
  const lines = [
    "You are a video question-answering engine. Answer the user's question about a video, grounded ONLY in the provided frames and transcript.",
    '',
    `Question: ${question}`,
    '',
    `Video metadata: ${JSON.stringify(metadata)}`,
    '',
    `You are given ${frames.length} frame(s) sampled from relevant time windows, in chronological order.`,
    `Frame timestamps: ${timestamps}.`,
  ]

  if (Array.isArray(matchedSegments) && matchedSegments.length > 0) {
    const excerpt = matchedSegments
      .map(
        (m) =>
          `[${(m.segment?.start ?? 0).toFixed(1)}s-${(m.segment?.end ?? 0).toFixed(1)}s] ${m.segment?.text ?? ''}`,
      )
      .join('\n')
      .slice(0, TRANSCRIPT_CHAR_BUDGET)
    lines.push('', 'Relevant transcript segments (speech, timestamped):', '', excerpt)
  } else if (!transcriptAvailable) {
    lines.push('', 'Note: no speech transcript is available for this video; answer from the frames alone if possible.')
  } else {
    lines.push('', 'Note: no transcript segment matched the question; answer from the frames alone, and say so in notes.')
  }

  lines.push(
    '',
    'Respond with STRICT JSON only, no markdown fences, matching exactly this shape:',
    '{',
    '  "answer": "direct, concise answer to the question",',
    '  "supporting_timestamps": [<numbers: times the answer is based on>],',
    '  "confidence": "high|medium|low",',
    '  "notes": "what you based the answer on, and what remains uncertain"',
    '}',
  )
  return lines.join('\n')
}

// Builds the analysis prompt. `transcript` is optional `{ text, segments }`;
// when present, timestamped speech is included so the VLM can answer from
// audio + vision together.
export function buildAnalysisPrompt({ metadata, frames, transcript }) {
  const timestamps = frames.map((f) => `${f.timestampSec}s`).join(', ')
  const lines = [
    'You are a video understanding engine. Analyze the frames sampled from a video.',
    '',
    `Video metadata (from ffprobe): ${JSON.stringify(metadata)}`,
    '',
    `You are given ${frames.length} frame(s) sampled across the timeline (scene-aware), in chronological order.`,
    `Frame timestamps: ${timestamps}.`,
  ]

  if (transcript && transcript.text) {
    const segs = Array.isArray(transcript.segments) ? transcript.segments : []
    const hasSegs = segs.length > 0 && segs.some((s) => s.end != null)
    const excerpt = hasSegs
      ? segs
          .map((s) => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.text}`)
          .join('\n')
      : transcript.text
    lines.push(
      '',
      `Transcript (speech${hasSegs ? ', timestamped' : ''}; use it to answer what is SAID, not just what is shown):`,
      '',
      excerpt.slice(0, TRANSCRIPT_CHAR_BUDGET),
    )
  }

  lines.push(
    '',
    'Respond with STRICT JSON only, no markdown fences, matching exactly this shape:',
    '{',
    '  "overall_summary": "one-paragraph summary of what this video shows and says",',
    '  "timeline": [{"timestamp_sec": <number>, "description": "what is visible in this frame"}],',
    '  "on_screen_text": "any text visible across frames (OCR), empty string if none",',
    '  "visual_style": "brief note on visual style, setting, quality",',
    '  "notable_moments": "anything unusual or noteworthy, empty string if none"',
    '}',
  )
  return lines.join('\n')
}
