// Frame sampling and extraction via ffmpeg.
//
// v0.2: scene-change-aware keyframe selection via the `scdet` filter
// (ffmpeg >= 6.0). Uniform midpoint sampling remains the fallback for videos
// with no detectable scene changes, and for very short clips.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

const MAX_BUFFER = 16 * 1024 * 1024
const FRAME_TIMEOUT_MS = 60_000
const SCENE_TIMEOUT_MS = 120_000
// Keep concurrent ffmpeg processes bounded; each spawn is a full decoder.
const MAX_CONCURRENCY = 3

// N timestamps at interval midpoints: (i + 0.5) / N * duration.
// Falls back to a single frame at 0s when duration is unknown.
export function planTimestamps(durationSec, count) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0]
  const n = Math.max(1, Math.floor(count))
  return Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * durationSec)
}

// Scene-change detection via ffmpeg's scdet filter. Returns a sorted list of
// shot boundaries `[{ timeSec, score }]` (score 0-100). Returns an empty list
// when scdet is unavailable (ffmpeg < 6.0) or analysis fails — callers then
// fall back to uniform sampling.
export async function detectScenes(
  videoPath,
  { threshold = 10, timeoutMs = SCENE_TIMEOUT_MS, signal } = {},
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-v', 'info',
        '-i', videoPath,
        '-vf', `scdet=threshold=${threshold},metadata=print`,
        '-an', '-f', 'null', '-',
      ],
      { maxBuffer: MAX_BUFFER, signal: signalAll },
    )
    return parseScdetOutput(stderr)
  } catch {
    // scdet unavailable or analysis failed: degrade gracefully.
    return []
  }
}

// ffmpeg's scdet emits per-frame `lavfi.scd.score` lines (0-1 scale) and, on
// detected cuts, a `lavfi.scd.time` line without a score — so we carry the
// last seen score forward when a cut line appears.
function parseScdetOutput(text) {
  const shots = []
  let lastScore
  for (const line of text.split('\n')) {
    const score = line.match(/lavfi\.scd\.score=([0-9.]+)/)
    if (score) lastScore = Number(score[1])
    const time = line.match(/lavfi\.scd\.time=([0-9.]+)/)
    if (time) shots.push({ timeSec: Number(time[1]), score: lastScore })
  }
  return shots.sort((a, b) => a.timeSec - b.timeSec)
}

// Choose representative timestamps from detected shots: one midpoint per shot,
// capped at `count` (downsampled evenly when shots exceed the budget). Falls
// back to uniform midpoint sampling when no shots were detected.
export function planShotTimestamps(durationSec, shots, count) {
  const n = Math.max(1, Math.floor(count))
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0]
  if (!Array.isArray(shots) || shots.length === 0) {
    return planTimestamps(durationSec, n)
  }

  // Segments: [0..t1, t1..t2, ..., tn..duration]; representative = midpoint.
  const bounds = shots
    .map((s) => s.timeSec)
    .filter((t) => Number.isFinite(t) && t > 0 && t < durationSec)
  const segments = []
  let prev = 0
  for (const b of bounds) {
    if (b > prev) segments.push([prev, b])
    prev = b
  }
  if (prev < durationSec) segments.push([prev, durationSec])

  const m = segments.length
  let picks
  if (m >= n) {
    // More shots than budget: one midpoint per shot, downsampled evenly.
    const midpoints = segments.map(([a, b]) => (a + b) / 2)
    const step = midpoints.length / n
    picks = Array.from({ length: n }, (_, i) =>
      midpoints[Math.min(midpoints.length - 1, Math.floor(i * step))],
    )
  } else {
    // Fewer shots than budget: distribute frames across segments
    // proportionally to segment length, at least one per segment.
    const totalLen = segments.reduce((s, [a, b]) => s + (b - a), 0)
    const raw = segments.map(([a, b]) => (n * (b - a)) / totalLen)
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
    picks = []
    segments.forEach(([a, b], i) => {
      const k = counts[i]
      for (let j = 0; j < k; j++) picks.push(a + ((j + 0.5) / k) * (b - a))
    })
  }
  return picks.map((t) => Math.round(t * 100) / 100)
}

async function extractFrame({ videoPath, timestampSec, maxWidth, quality, outFile, signal, timeoutMs = FRAME_TIMEOUT_MS }) {
  // -ss before -i is a fast seek; for short clips accuracy is fine at frame level.
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  await execFileAsync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-ss', timestampSec.toFixed(3),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-q:v', String(quality),
      outFile,
    ],
    { maxBuffer: MAX_BUFFER, signal: signalAll },
  )
  return readFile(outFile)
}

// Bounded-concurrency map: runs `fn` over items with at most `limit` in flight.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// Extracts `timestamps.length` JPEG frames and returns them base64-encoded,
// cleaning up the temp directory in all cases.
export async function extractFrames({ videoPath, timestamps, maxWidth, quality, signal }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-lens-'))
  try {
    const frames = await mapWithConcurrency(timestamps, MAX_CONCURRENCY, async (timestampSec, i) => {
      const outFile = join(dir, `frame-${String(i).padStart(3, '0')}.jpg`)
      const buffer = await extractFrame({
        videoPath,
        timestampSec,
        maxWidth,
        quality,
        outFile,
        signal,
      })
      return {
        timestampSec: Math.round(timestampSec * 100) / 100,
        base64: buffer.toString('base64'),
        bytes: buffer.length,
      }
    })
    return frames.filter((f) => f.bytes > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Duration-adaptive frame budget: short videos get denser sampling (they are
// cheap), long videos are capped to protect the VLM context window.
// `cap` is the configured maximum (config.maxFrames).
export function autoFrameBudget(durationSec, cap) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return Math.min(cap, 4)
  return Math.min(cap, Math.max(4, Math.ceil(durationSec / 30)))
}

// Resolution adapts to frame count: more frames → smaller frames, so total
// VLM tokens stay bounded (a 512px JPEG costs roughly 40% less than 768px).
export function adaptiveFrameWidth(frameCount, maxWidth) {
  if (frameCount >= 9) return Math.min(512, maxWidth)
  if (frameCount >= 6) return Math.min(640, maxWidth)
  return maxWidth
}

// Extracts a 16kHz mono WAV for ASR. Returns `{ wavPath, dir }` — caller must
// `rm(dir, { recursive: true, force: true })` when done.
export async function extractAudio({ videoPath, signal, timeoutMs = 60_000 }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-lens-audio-'))
  const wavPath = join(dir, 'audio.wav')
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath],
      { maxBuffer: MAX_BUFFER, signal: signalAll },
    )
    return { wavPath, dir }
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}
