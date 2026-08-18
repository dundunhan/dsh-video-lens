// ffprobe-based video metadata inspection.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, constants } from 'node:fs/promises'
import { basename } from 'node:path'

const execFileAsync = promisify(execFile)

const MAX_BUFFER = 16 * 1024 * 1024
const PROBE_TIMEOUT_MS = 15_000

export async function assertReadable(path) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

// ffmpeg/ffprobe treat any argv starting with '-' as an option, so a file
// whose name begins with '-' would be misparsed. Reject those outright; the
// agent should pass an absolute path (or rename the file).
export function assertSafePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string')
  }
  if (basename(path).startsWith('-')) {
    throw new Error(`path basename must not start with '-': ${path}`)
  }
}

// Parse an ffprobe rational like "64408000/2146933" or "30/1" into a number.
function parseRatio(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const [num, den] = value.split('/')
  const n = Number(num)
  const d = Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined
  return Math.round((n / d) * 100) / 100
}

export async function probeVideo(filePath, { timeoutMs = PROBE_TIMEOUT_MS, signal } = {}) {
  assertSafePath(filePath)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { maxBuffer: MAX_BUFFER, signal: signalAll },
  )
  return JSON.parse(stdout)
}

// Collapse the raw ffprobe dump into a compact, model-friendly summary.
export function summarizeProbe(probe) {
  const format = probe.format ?? {}
  const streams = probe.streams ?? []
  const video = streams.filter((s) => s.codec_type === 'video')
  const audio = streams.filter((s) => s.codec_type === 'audio')
  const subtitle = streams.filter((s) => s.codec_type === 'subtitle')

  const videoSummary = video.map((s) => ({
    index: s.index,
    codec: s.codec_name,
    width: s.width,
    height: s.height,
    fps: parseRatio(s.avg_frame_rate),
    durationSec: s.duration ? Number(s.duration) : undefined,
    bitRate: s.bit_rate,
    pixelFormat: s.pix_fmt,
  }))

  const audioSummary = audio.map((s) => ({
    index: s.index,
    codec: s.codec_name,
    sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
    channels: s.channels,
    language: s.tags?.language,
  }))

  return {
    container: format.format_name,
    durationSec: format.duration ? Number(format.duration) : undefined,
    sizeBytes: format.size ? Number(format.size) : undefined,
    overallBitRate: format.bit_rate ? Number(format.bit_rate) : undefined,
    videoStreams: videoSummary,
    audioStreams: audioSummary,
    subtitleStreams: subtitle.length,
    hasAudio: audio.length > 0,
    hasSubtitles: subtitle.length > 0,
  }
}
