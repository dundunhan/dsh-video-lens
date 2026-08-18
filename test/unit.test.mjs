// dsh-video-lens unit tests: pure functions only — no ffmpeg, no network,
// no API keys. Runs anywhere Node >= 20 is available (CI included).
import {
  parseTimeQuery,
  extractQueryTerms,
  matchSegments,
  buildWindows,
  planWindowFrames,
  askFrameBudget,
} from '../src/ask.js'
import { summarizeProbe } from '../src/probe.js'
import {
  planTimestamps,
  planShotTimestamps,
  autoFrameBudget,
  adaptiveFrameWidth,
} from '../src/frames.js'
import { buildAnalysisPrompt, buildAskPrompt } from '../src/vlm.js'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- ask.js: explicit time parsing ---
check('parse "3分20秒"', JSON.stringify(parseTimeQuery('这个视频3分20秒讲了什么')) === JSON.stringify({ start: 200, end: 210 }))
check('parse "第2分钟"', JSON.stringify(parseTimeQuery('第2分钟说了什么')) === JSON.stringify({ start: 120, end: 180 }))
check('parse "1:23"', JSON.stringify(parseTimeQuery('at 1:23 what happens')) === JSON.stringify({ start: 83, end: 93 }))
check('parse "200秒"', JSON.stringify(parseTimeQuery('200秒的时候')) === JSON.stringify({ start: 195, end: 205 }))
check('parse "2 minutes"', JSON.stringify(parseTimeQuery('at 2 minutes in')) === JSON.stringify({ start: 120, end: 180 }))
check('no time ref → null', parseTimeQuery('这个视频讲了什么') === null)

// --- ask.js: term extraction ---
const terms = extractQueryTerms('视频里提到推理协议了吗')
check('zh terms include 3-gram', terms.includes('推理协'), terms.join(','))
check('zh terms include 2-gram', terms.includes('协议'))
const enTerms = extractQueryTerms('what did he say about the harness mode')
check('en terms drop stop words', enTerms.includes('harness') && !enTerms.includes('the'), enTerms.join(','))

// --- ask.js: segment matching ---
const segs = [
  { start: 0, end: 5, text: '今天我们来介绍极简模式的使用方法' },
  { start: 10, end: 15, text: '推理协议和验证协议是长任务控制的核心' },
  { start: 20, end: 25, text: '十六组结果对比非常明显' },
]
const matched = matchSegments(segs, extractQueryTerms('推理协议是什么'))
check('match finds the right segment', matched.length >= 1 && matched[0].segment === segs[1], matched.map((m) => `${m.score}:${m.segment.text}`).join(' | '))

// --- ask.js: windows ---
const windows = buildWindows(matched, 2, 300)
check('windows padded & merged', windows.length === 1 && Math.abs(windows[0].start - 8) < 0.01 && Math.abs(windows[0].end - 17) < 0.01)
const multiWindows = buildWindows(
  [
    { segment: { start: 10, end: 12 } },
    { segment: { start: 14, end: 16 } },
    { segment: { start: 100, end: 102 } },
  ],
  2,
  300,
)
check('adjacent windows merge, far windows stay apart', multiWindows.length === 2)

// --- ask.js: frame allocation ---
const planned = planWindowFrames(windows, 6)
check('window frames fill budget', planned.reduce((s, w) => s + w.timestamps.length, 0) === 6)
check('window timestamps inside window', planned[0].timestamps.every((t) => t >= windows[0].start && t <= windows[0].end))
const plannedMulti = planWindowFrames(multiWindows, 6)
check('multi-window: each ≥1 frame, total = 6', plannedMulti.every((w) => w.timestamps.length >= 1) && plannedMulti.reduce((s, w) => s + w.timestamps.length, 0) === 6)

// --- ask.js: budgets ---
check('askFrameBudget: 30s → 10', askFrameBudget(30, undefined) === 10)
check('askFrameBudget: 9s → 3', askFrameBudget(9, undefined) === 3)
check('askFrameBudget: 2s → 2 (floor)', askFrameBudget(2, undefined) === 2)
check('askFrameBudget: 60s → 12 (ceiling)', askFrameBudget(60, undefined) === 12)
check('askFrameBudget: explicit wins', askFrameBudget(30, 6) === 6)

// --- frames.js: sampling plans ---
check('planTimestamps count', planTimestamps(100, 6).length === 6)
check('planTimestamps midpoint', Math.abs(planTimestamps(100, 1)[0] - 50) < 0.01)
check('planTimestamps unknown duration → [0]', planTimestamps(NaN, 6)[0] === 0)
const shotTs = planShotTimestamps(300, [{ timeSec: 100, score: 50 }, { timeSec: 200, score: 60 }], 6)
check('planShotTimestamps fills budget with few shots', shotTs.length === 6, shotTs.join(','))
const manyShotTs = planShotTimestamps(300, Array.from({ length: 20 }, (_, i) => ({ timeSec: (i + 1) * 14, score: 50 })), 6)
check('planShotTimestamps downsamples many shots', manyShotTs.length === 6)
check('planShotTimestamps fallback to uniform', JSON.stringify(planShotTimestamps(100, [], 4)) === JSON.stringify(planTimestamps(100, 4)))

// --- frames.js: adaptive budgets ---
check('autoFrameBudget: 30s → 4', autoFrameBudget(30, 12) === 4)
check('autoFrameBudget: 180s → 6', autoFrameBudget(180, 12) === 6)
check('autoFrameBudget: 268s → 9', autoFrameBudget(268, 12) === 9)
check('autoFrameBudget: 600s → 12 (capped)', autoFrameBudget(600, 12) === 12)
check('autoFrameBudget: user cap wins', autoFrameBudget(268, 6) === 6)
check('adaptiveFrameWidth: 4 → 768', adaptiveFrameWidth(4, 768) === 768)
check('adaptiveFrameWidth: 6 → 640', adaptiveFrameWidth(6, 768) === 640)
check('adaptiveFrameWidth: 9 → 512', adaptiveFrameWidth(9, 768) === 512)
check('adaptiveFrameWidth: never exceeds config', adaptiveFrameWidth(12, 400) === 400)

// --- probe.js: summarizeProbe (pure, mocked ffprobe dump) ---
const mockProbe = {
  format: { format_name: 'mov,mp4,m4a', duration: '3.0', size: '52088', bit_rate: '138901' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360, avg_frame_rate: '64408000/2146933', pix_fmt: 'yuv420p' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 1, tags: { language: 'und' } },
    { index: 2, codec_type: 'subtitle', codec_name: 'ass' },
  ],
}
const summary = summarizeProbe(mockProbe)
check('summarizeProbe fps normalized to number', typeof summary.videoStreams[0].fps === 'number' && Math.abs(summary.videoStreams[0].fps - 30) < 0.01, String(summary.videoStreams[0].fps))
check('summarizeProbe keeps original stream index', summary.videoStreams[0].index === 0 && summary.audioStreams[0].index === 1)
check('summarizeProbe flags', summary.hasAudio === true && summary.hasSubtitles === true && summary.subtitleStreams === 1)

// --- vlm.js: prompts ---
const fakeFrames = [{ timestampSec: 1, base64: '', bytes: 1 }, { timestampSec: 2, base64: '', bytes: 1 }]
const fakeMeta = { durationSec: 3, container: 'mp4' }
const p1 = buildAnalysisPrompt({ metadata: fakeMeta, frames: fakeFrames })
check('analysis prompt baseline', p1.includes('STRICT JSON') && p1.includes('overall_summary'))
const p2 = buildAnalysisPrompt({
  metadata: fakeMeta,
  frames: fakeFrames,
  transcript: { text: 'hi', segments: [{ start: 0, end: 1, text: 'hi' }] },
})
check('analysis prompt embeds timestamped transcript', p2.includes('[0.0s-1.0s] hi'))
const p3 = buildAnalysisPrompt({
  metadata: fakeMeta,
  frames: fakeFrames,
  transcript: { text: 'plain text only', segments: [{ start: 0, end: null, text: 'plain text only' }] },
})
check('analysis prompt supports text-only transcript', p3.includes('plain text only') && !p3.includes('[0.0s-'))
const q1 = buildAskPrompt({ metadata: fakeMeta, frames: fakeFrames, question: 'q', matchedSegments: [{ segment: { start: 1, end: 2, text: 'hit' }, score: 3 }], transcriptAvailable: true })
check('ask prompt embeds matched segments', q1.includes('[1.0s-2.0s] hit'))
const q2 = buildAskPrompt({ metadata: fakeMeta, frames: fakeFrames, question: 'q', matchedSegments: [], transcriptAvailable: false })
check('ask prompt notes missing transcript', q2.includes('no speech transcript is available'))

const passed = results.filter((r) => r.ok).length
console.log(`\nRESULT: ${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
