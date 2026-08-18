// dsh-video-lens end-to-end tests: run the real ffmpeg/ffprobe pipeline on a
// synthetic video generated on the fly (testsrc2 + sine audio). No API keys,
// no network: ASR degrades to null and the visual path must still complete.
// Requires ffmpeg/ffprobe on PATH.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeVideo, summarizeProbe, assertSafePath } from '../src/probe.js'
import {
  detectScenes,
  planShotTimestamps,
  planTimestamps,
  extractFrames,
  extractAudio,
  autoFrameBudget,
  adaptiveFrameWidth,
} from '../src/frames.js'
import { transcribe } from '../src/asr.js'
import { buildAnalysisPrompt } from '../src/vlm.js'

const execFileAsync = promisify(execFile)
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Build a 4-second synthetic clip: color bars + moving test pattern + audio.
const dir = await mkdtemp(join(tmpdir(), 'dsh-video-lens-e2e-'))
const VIDEO = join(dir, 'synthetic.mp4')
try {
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', "testsrc2=size=640x360:rate=30:duration=4",
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    VIDEO,
  ])

  // --- path safety ---
  try {
    assertSafePath('/tmp/-evil.mp4')
    check('assertSafePath rejects -prefix', false, 'should have thrown')
  } catch {
    check('assertSafePath rejects -prefix', true)
  }

  // --- probe ---
  const raw = await probeVideo(VIDEO)
  const meta = summarizeProbe(raw)
  check('probe fps is number', typeof meta.videoStreams[0]?.fps === 'number', `fps=${meta.videoStreams[0]?.fps}`)
  check('probe has audio', meta.hasAudio === true)
  check('probe duration ~4s', Math.abs((meta.durationSec ?? 0) - 4) < 0.5, `duration=${meta.durationSec}`)

  // --- scene detection on synthetic pattern (may find 0 shots → fallback) ---
  const shots = await detectScenes(VIDEO)
  check('scdet returns array', Array.isArray(shots), `shots=${shots.length}`)

  // --- shot-aware + adaptive sampling ---
  const frameCount = Math.min(Math.max(1, Math.floor(autoFrameBudget(meta.durationSec, 12))), 12)
  const frameWidth = adaptiveFrameWidth(frameCount, 768)
  const ts = planShotTimestamps(meta.durationSec, shots, frameCount)
  check('adaptive frame count on 4s clip', frameCount === 4, `${frameCount} frames @ ${frameWidth}px`)
  check('shot timestamps count', ts.length === frameCount, ts.join(','))
  check('uniform fallback works', planTimestamps(meta.durationSec, 4).length === 4)

  // --- frame extraction ---
  const frames = await extractFrames({ videoPath: VIDEO, timestamps: ts, maxWidth: frameWidth, quality: 4 })
  check('frames extracted', frames.length === frameCount && frames.every((f) => f.bytes > 0), frames.map((f) => f.bytes).join(','))

  // --- audio extraction ---
  const { wavPath, dir: audioDir } = await extractAudio({ videoPath: VIDEO })
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', wavPath])
  const audioInfo = JSON.parse(stdout).streams?.[0] ?? {}
  check('audio extracted as 16k mono wav', audioInfo.codec_name === 'pcm_s16le' && audioInfo.sample_rate === '16000' && audioInfo.channels === 1, JSON.stringify(audioInfo))
  await rm(audioDir, { recursive: true, force: true })

  // --- ASR without key → null (graceful degradation) ---
  const t = await transcribe(VIDEO, {
    asrBaseUrl: 'https://api.siliconflow.cn/v1',
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
    asrApiKeyEnv: 'VIDEO_LENS_ASR_KEY_UNSET_IN_CI',
  })
  check('ASR degrades to null without key', t === null, String(t))

  // --- prompt with transcript ---
  const prompt = buildAnalysisPrompt({
    metadata: meta,
    frames,
    transcript: { text: 'hello world', segments: [{ start: 0, end: 1, text: 'hello world' }] },
  })
  check('prompt embeds transcript', prompt.includes('[0.0s-1.0s] hello world'))
} finally {
  await rm(dir, { recursive: true, force: true })
}

const passed = results.filter((r) => r.ok).length
console.log(`\nRESULT: ${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
