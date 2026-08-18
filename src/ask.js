// Time-anchored question answering over transcript + shots (v0.3).
//
// Pure, dependency-free helpers: explicit time-reference parsing, query-term
// extraction (Chinese n-grams + English words), transcript segment matching,
// window building/merging, and per-window frame-budget allocation. Everything
// here is unit-testable without ffmpeg or network.
import { planTimestamps } from './frames.js'

// --- Explicit time references ------------------------------------------------

// Ordered from most specific to least; first match wins, so "3分20秒" is
// consumed by the combined pattern before the bare "秒" pattern can grab "20秒".
const TIME_PATTERNS = [
  { re: /(\d+)\s*分\s*(\d+)\s*秒/, to: (m) => ({ start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[1]) * 60 + Number(m[2]) + 10 }) },
  { re: /(\d+)\s*分钟/, to: (m) => ({ start: Number(m[1]) * 60, end: (Number(m[1]) + 1) * 60 }) },
  { re: /(\d+)\s*分/, to: (m) => ({ start: Number(m[1]) * 60, end: (Number(m[1]) + 1) * 60 }) },
  { re: /(\d+):(\d{2})/, to: (m) => ({ start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[1]) * 60 + Number(m[2]) + 10 }) },
  { re: /(\d+)\s*秒/, to: (m) => ({ start: Math.max(0, Number(m[1]) - 5), end: Number(m[1]) + 5 }) },
  { re: /(\d+)\s*(?:minutes?|min)\b/, to: (m) => ({ start: Number(m[1]) * 60, end: (Number(m[1]) + 1) * 60 }) },
  { re: /(\d+)\s*(?:seconds?|sec)\b/, to: (m) => ({ start: Math.max(0, Number(m[1]) - 5), end: Number(m[1]) + 5 }) },
]

// Parses an explicit time reference out of a question. Returns
// `{ start, end }` (seconds) or null when the question has no time reference.
export function parseTimeQuery(question) {
  if (typeof question !== 'string' || question.length === 0) return null
  for (const { re, to } of TIME_PATTERNS) {
    const m = question.match(re)
    if (m) return to(m)
  }
  return null
}

// --- Query-term extraction ---------------------------------------------------

// Lightweight stop words for English; Chinese is handled by n-grams, which
// don't need stop words.
const EN_STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'of',
  'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or', 'but', 'what', 'when',
  'where', 'who', 'how', 'why', 'this', 'that', 'video', 'about', 'tell',
  'say', 'said', 'says', 'mention', 'mentions', 'mentioned', 'please', 'can',
  'you', 'me', 'it', 'its', 'he', 'she', 'they', 'we', 'i', 'my', 'your',
])

// Extracts search terms from a question: Chinese character n-grams (3-gram
// with 2-gram fallback) and English words minus stop words.
export function extractQueryTerms(question) {
  if (typeof question !== 'string' || question.length === 0) return []
  const terms = new Set()

  // English words
  const en = question.match(/[A-Za-z][A-Za-z'-]*/g) ?? []
  for (const w of en) {
    const lower = w.toLowerCase()
    if (!EN_STOP.has(lower) && lower.length >= 2) terms.add(lower)
  }

  // Chinese n-grams: 3-gram preferred, 2-gram as fallback coverage.
  const han = (question.match(/[\u4e00-\u9fff]+/g) ?? []).join('')
  if (han.length >= 3) {
    for (let i = 0; i + 3 <= han.length; i++) terms.add(han.slice(i, i + 3))
  }
  if (han.length >= 2) {
    for (let i = 0; i + 2 <= han.length; i++) terms.add(han.slice(i, i + 2))
  }
  return [...terms]
}

// --- Segment matching --------------------------------------------------------

// Scores transcript segments against query terms. Longer terms weigh more
// (a matched 3-gram is worth more than a matched 2-gram). Returns entries
// sorted by descending score, each `{ segment, score, hits }`.
export function matchSegments(segments, terms) {
  if (!Array.isArray(segments) || !Array.isArray(terms) || terms.length === 0) {
    return []
  }
  const scored = []
  for (const segment of segments) {
    const hits = terms.filter((t) => (segment.text ?? '').includes(t))
    const score = hits.reduce((sum, t) => sum + (t.length - 1), 0)
    if (score > 0) scored.push({ segment, score, hits })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

// --- Windows -----------------------------------------------------------------

// Builds time windows from matched segments: each segment padded by
// `paddingSec`, overlapping windows merged. Clamped to [0, durationSec].
export function buildWindows(matched, paddingSec = 2, durationSec) {
  const spans = matched
    .map(({ segment }) => ({
      start: Math.max(0, (segment.start ?? 0) - paddingSec),
      end: Math.min(durationSec, (segment.end ?? segment.start ?? 0) + paddingSec),
    }))
    .sort((a, b) => a.start - b.start)
  const merged = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  return merged
}

// Frame budget for video_ask windows: ~1 frame per 3 seconds of matched
// window, floor 2, ceiling 12 (context-safe). An explicit `explicitFrames`
// (the user-supplied maxFrames arg) always wins.
export function askFrameBudget(windowSeconds, explicitFrames) {
  if (Number.isFinite(explicitFrames) && explicitFrames > 0) {
    return Math.floor(explicitFrames)
  }
  return Math.min(Math.max(2, Math.ceil(windowSeconds / 3)), 12)
}

// Allocates the frame budget across windows proportionally to window length,
// at least one frame per window; frames are uniformly sampled inside each
// window. Returns `[{ start, end, timestamps }]`.
export function planWindowFrames(windows, totalFrames) {
  const n = Math.max(1, Math.floor(totalFrames))
  if (!Array.isArray(windows) || windows.length === 0) {
    return []
  }
  const totalLen = windows.reduce((s, w) => s + (w.end - w.start), 0)
  if (totalLen <= 0) {
    return windows.map((w) => ({
      ...w,
      timestamps: [Math.round(w.start * 100) / 100],
    }))
  }
  const raw = windows.map((w) => (n * (w.end - w.start)) / totalLen)
  const counts = raw.map((c) => Math.max(1, Math.floor(c)))
  let deficit = n - counts.reduce((s, c) => s + c, 0)
  if (deficit > 0) {
    const order = raw
      .map((_, i) => i)
      .sort((x, y) => raw[y] - Math.floor(raw[y]) - (raw[x] - Math.floor(raw[x])))
    for (let i = 0; deficit > 0; i++, deficit--) counts[order[i % order.length]]++
  }
  while (deficit < 0) {
    const idx = counts.findIndex((c) => c > 1)
    if (idx === -1) break
    counts[idx]--
    deficit++
  }
  return windows.map((w, i) => ({
    start: w.start,
    end: w.end,
    timestamps: planTimestamps(w.end - w.start, counts[i]).map(
      (t) => Math.round((w.start + t) * 100) / 100,
    ),
  }))
}
