// dsh-video-lens - give text-only DeepSeek Harness agents video understanding.
//
// Tools:
//   video_probe    - ffprobe metadata (container, duration, codecs, tracks)
//   video_analyze  - scene-aware frame sampling + optional ASR transcript,
//                    fused with a vision model into evidence JSON
//
// Vision is delegated to any OpenAI-compatible multimodal endpoint
// (SiliconFlow, DashScope, Gemini compat, vLLM, Ollama, ...) via config - the
// plugin never locks users into a single provider. ASR is equally pluggable
// (any OpenAI-compatible /audio/transcriptions endpoint) and strictly
// additive: a missing ASR key never breaks the visual path.
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { assertReadable, assertSafePath, probeVideo, summarizeProbe } from './probe.js'
import { planShotTimestamps, detectScenes, extractFrames, autoFrameBudget, adaptiveFrameWidth } from './frames.js'
import { chatWithVision, buildAnalysisPrompt, buildAskPrompt, parseAnalysis } from './vlm.js'
import { transcribe } from './asr.js'
import {
  parseTimeQuery,
  extractQueryTerms,
  matchSegments,
  buildWindows,
  planWindowFrames,
  askFrameBudget,
} from './ask.js'

export const name = 'dsh-video-lens'

// Wait for the tool registry before registering our tools.
export const inject = ['tools']

export const Config = Schema.object({
  // Vision provider (OpenAI-compatible chat-completions endpoint).
  visionBaseUrl: Schema.string().default('https://api.siliconflow.cn/v1'),
  visionModel: Schema.string().default('Qwen/Qwen3-VL-8B-Instruct'),
  visionApiKeyEnv: Schema.string().default('VIDEO_LENS_API_KEY'),
  // ASR provider (OpenAI-compatible /audio/transcriptions endpoint).
  asrBaseUrl: Schema.string().default('https://api.siliconflow.cn/v1'),
  asrModel: Schema.string().default('FunAudioLLM/SenseVoiceSmall'),
  asrApiKeyEnv: Schema.string().default('VIDEO_LENS_ASR_KEY'),
  // Sampling budget (upper cap; actual count is duration-adaptive:
  // ~1 frame per 30s of video, denser for shorts, bounded by this cap).
  maxFrames: Schema.number().default(12),
  frameMaxWidth: Schema.number().default(768),
  frameQuality: Schema.number().default(4),
  // Scene detection (scdet threshold, 0-100; higher = fewer cuts).
  sceneThreshold: Schema.number().default(10),
  // video_ask window padding around matched transcript segments.
  askPaddingSec: Schema.number().default(2),
  // Vision call budget.
  vlmMaxTokens: Schema.number().default(1500),
  vlmTimeoutMs: Schema.number().default(90_000),
  asrTimeoutMs: Schema.number().default(120_000),
})

function toolErrorMessage(err) {
  if (err.code === 'ENOENT') {
    return 'ERROR: ffmpeg/ffprobe not found on PATH. Install ffmpeg first (brew install ffmpeg / apt install ffmpeg).'
  }
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return `ERROR: operation timed out or was cancelled: ${err.message}`
  }
  return `ERROR: ${err.message}`
}

function registerVideoProbe(ctx) {
  ctx.tools.register(defineTool({
    name: 'video_probe',
    description:
      'Inspect a local video file and return its metadata as JSON: container, duration, ' +
      'resolution, fps, codecs, audio tracks, embedded subtitles. Use this first when asked ' +
      'anything about a video file, before deeper analysis.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the video file (mp4, mov, mkv, webm, ...)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { path } = args

      try {
        assertSafePath(path)
      } catch (err) {
        return toolErrorMessage(err)
      }

      if (!(await assertReadable(path))) {
        return `ERROR: file not found or not readable: ${path}`
      }

      let probe
      try {
        probe = await probeVideo(path)
      } catch (err) {
        return toolErrorMessage(err)
      }

      return JSON.stringify(summarizeProbe(probe), null, 2)
    },
  }))
}

function registerVideoAnalyze(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'video_analyze',
    description:
      'Understand the CONTENT of a local video file: detects scene changes, samples ' +
      'representative frames, optionally transcribes speech (ASR), and returns structured ' +
      'evidence JSON (overall summary, per-frame timeline, on-screen text, notable moments). ' +
      'Use after video_probe when the user asks what HAPPENS in a video, what is said, or ' +
      'what text appears.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the video file',
      },
      maxFrames: {
        type: 'number',
        description: `Frames to sample (1-${config.maxFrames}; default: duration-adaptive, denser for short videos). More frames = better temporal coverage but slower and costlier.`,
      },
      question: {
        type: 'string',
        description: 'Optional focus: what to pay attention to while analyzing.',
      },
    },
    timeoutMs: config.vlmTimeoutMs + config.asrTimeoutMs + 120_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const { path, question } = args

      try {
        assertSafePath(path)
      } catch (err) {
        return toolErrorMessage(err)
      }

      if (!(await assertReadable(path))) {
        return `ERROR: file not found or not readable: ${path}`
      }

      const apiKey = process.env[config.visionApiKeyEnv]
      if (!apiKey) {
        return (
          `ERROR: vision API key not set. Export ${config.visionApiKeyEnv} with a key for ` +
          `${config.visionBaseUrl} (model: ${config.visionModel}), or point the plugin's ` +
          'visionBaseUrl/visionModel config at any OpenAI-compatible vision endpoint.'
        )
      }

      try {
        const probe = await probeVideo(path)
        const metadata = summarizeProbe(probe)
        const duration = metadata.durationSec ?? metadata.videoStreams[0]?.durationSec

        // Duration-adaptive budget: explicit maxFrames wins, otherwise short
        // videos sample denser. Resolution scales down as frames go up so the
        // total VLM payload stays bounded.
        const frameCount = Math.min(
          Math.max(1, Math.floor(args.maxFrames ?? autoFrameBudget(duration, config.maxFrames))),
          config.maxFrames,
        )
        const frameWidth = adaptiveFrameWidth(frameCount, config.frameMaxWidth)

        // Scene-aware sampling: shots first, then one representative frame per
        // shot (capped at frameCount), falling back to uniform midpoints.
        const shots = await detectScenes(path, {
          threshold: config.sceneThreshold,
          signal: exec?.signal,
        })
        const timestamps = planShotTimestamps(duration, shots, frameCount)
        const frames = await extractFrames({
          videoPath: path,
          timestamps,
          maxWidth: frameWidth,
          quality: config.frameQuality,
          signal: exec?.signal,
        })

        if (frames.length === 0) {
          return 'ERROR: ffmpeg extracted no frames - the file may be audio-only or corrupted.'
        }

        // Optional ASR: missing key or provider failure degrades gracefully —
        // the visual path always completes, and the error is surfaced in the
        // evidence so operators can tell "no key" from "provider error".
        let transcript = null
        let transcriptError = null
        if (metadata.hasAudio) {
          try {
            transcript = await transcribe(path, {
              asrBaseUrl: config.asrBaseUrl,
              asrModel: config.asrModel,
              asrApiKeyEnv: config.asrApiKeyEnv,
              timeoutMs: config.asrTimeoutMs,
              signal: exec?.signal,
            })
          } catch (err) {
            transcriptError = err.message
          }
        }

        let prompt = buildAnalysisPrompt({ metadata, frames, transcript })
        if (question) {
          prompt += `\n\nPay special attention to: ${question}`
        }

        const raw = await chatWithVision({
          baseUrl: config.visionBaseUrl,
          apiKey,
          model: config.visionModel,
          prompt,
          frames,
          maxTokens: config.vlmMaxTokens,
          timeoutMs: config.vlmTimeoutMs,
          signal: exec?.signal,
        })

        const evidence = {
          metadata,
          shots: shots.map((s) => ({
            timeSec: Math.round(s.timeSec * 100) / 100,
            score: s.score ?? null,
          })),
          framesSampled: frames.map((f) => ({
            timestampSec: f.timestampSec,
            jpegBytes: f.bytes,
          })),
          transcript:
            transcript && transcript.text
              ? {
                  text: transcript.text,
                  segments: transcript.segments,
                  language: transcript.language ?? null,
                }
              : null,
          transcriptError,
          visionModel: config.visionModel,
          ...parseAnalysis(raw),
        }
        return JSON.stringify(evidence, null, 2)
      } catch (err) {
        return toolErrorMessage(err)
      }
    },
  }))
}

function registerVideoAsk(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'video_ask',
    description:
      'Answer a TIME-ANCHORED question about a video: parses explicit time references ' +
      '("at 3:20", "第2分钟") or locates relevant speech via transcript keyword matching, ' +
      're-samples frames from the matched time windows, and answers with grounded evidence ' +
      '(answer + confidence + supporting timestamps). Use when the user asks WHEN something ' +
      'is said or shown in a video.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the video file',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The question to answer; may include a time reference (e.g. "at 3:20", "第2分钟").',
      },
      maxFrames: {
        type: 'number',
        description: `Frames to sample (1-${config.maxFrames}; default: window-density based, ~1 frame per 3s of matched window).`,
      },
    },
    timeoutMs: config.vlmTimeoutMs + config.asrTimeoutMs + 120_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const { path, question } = args

      if (typeof question !== 'string' || question.trim().length === 0) {
        return 'ERROR: question is required for video_ask'
      }

      try {
        assertSafePath(path)
      } catch (err) {
        return toolErrorMessage(err)
      }

      if (!(await assertReadable(path))) {
        return `ERROR: file not found or not readable: ${path}`
      }

      const apiKey = process.env[config.visionApiKeyEnv]
      if (!apiKey) {
        return (
          `ERROR: vision API key not set. Export ${config.visionApiKeyEnv} with a key for ` +
          `${config.visionBaseUrl} (model: ${config.visionModel}), or point the plugin's ` +
          'visionBaseUrl/visionModel config at any OpenAI-compatible vision endpoint.'
        )
      }

      try {
        const probe = await probeVideo(path)
        const metadata = summarizeProbe(probe)
        const duration = metadata.durationSec ?? metadata.videoStreams[0]?.durationSec

        const shots = await detectScenes(path, {
          threshold: config.sceneThreshold,
          signal: exec?.signal,
        })

        let transcript = null
        let transcriptError = null
        if (metadata.hasAudio) {
          try {
            transcript = await transcribe(path, {
              asrBaseUrl: config.asrBaseUrl,
              asrModel: config.asrModel,
              asrApiKeyEnv: config.asrApiKeyEnv,
              timeoutMs: config.asrTimeoutMs,
              signal: exec?.signal,
            })
          } catch (err) {
            transcriptError = err.message
          }
        }

        // Locate relevant time windows: explicit time reference wins, then
        // transcript keyword matching; otherwise fall back to the whole film.
        // Untimed segments (text-only ASR) are normalized to the full
        // duration so matching still works.
        const explicit = parseTimeQuery(question)
        let matchedSegments = []
        let windows = []
        if (explicit) {
          // Clamp explicit windows to the video duration; refuse windows that
          // fall entirely outside it with a clear, actionable error.
          const start = Math.max(0, Math.min(explicit.start, duration))
          const end = Math.max(0, Math.min(explicit.end, duration))
          if (end <= start || start >= duration) {
            return (
              `ERROR: requested time window [${explicit.start}s-${explicit.end}s] falls entirely ` +
              `outside the video duration (${Math.round(duration)}s).`
            )
          }
          windows = [{ start, end }]
        } else if (transcript && transcript.text) {
          const normSegments = transcript.segments.map((s) =>
            s.end == null ? { ...s, end: duration } : s,
          )
          const terms = extractQueryTerms(question)
          matchedSegments = matchSegments(normSegments, terms).slice(0, 5)
          windows = buildWindows(matchedSegments, config.askPaddingSec, duration)
        }

        let timestamps
        let frameCount
        if (windows.length > 0) {
          // Window-density budget: ~1 frame per 3s of matched window (2-12),
          // unless the caller passed an explicit maxFrames.
          const windowSeconds = windows.reduce((s, w) => s + (w.end - w.start), 0)
          frameCount = Math.min(
            Math.max(1, Math.floor(askFrameBudget(windowSeconds, args.maxFrames))),
            config.maxFrames,
          )
          const planned = planWindowFrames(windows, frameCount)
          timestamps = planned.flatMap((w) => w.timestamps)
          windows = planned.map((w) => ({
            start: Math.round(w.start * 100) / 100,
            end: Math.round(w.end * 100) / 100,
          }))
        } else {
          // Fallback: no matched window → whole-film, duration-adaptive.
          frameCount = Math.min(
            Math.max(1, Math.floor(args.maxFrames ?? autoFrameBudget(duration, config.maxFrames))),
            config.maxFrames,
          )
          timestamps = planShotTimestamps(duration, shots, frameCount)
        }
        const frameWidth = adaptiveFrameWidth(frameCount, config.frameMaxWidth)

        const frames = await extractFrames({
          videoPath: path,
          timestamps,
          maxWidth: frameWidth,
          quality: config.frameQuality,
          signal: exec?.signal,
        })

        if (frames.length === 0) {
          return 'ERROR: ffmpeg extracted no frames - the file may be audio-only or corrupted.'
        }

        const prompt = buildAskPrompt({
          metadata,
          frames,
          question,
          matchedSegments,
          transcriptAvailable: !!(transcript && transcript.text),
        })

        const raw = await chatWithVision({
          baseUrl: config.visionBaseUrl,
          apiKey,
          model: config.visionModel,
          prompt,
          frames,
          maxTokens: config.vlmMaxTokens,
          timeoutMs: config.vlmTimeoutMs,
          signal: exec?.signal,
        })

        const evidence = {
          metadata,
          question,
          matchedSegments: matchedSegments.map((m) => ({
            start: m.segment?.start ?? null,
            end: m.segment?.end ?? null,
            text: m.segment?.text ?? '',
            score: m.score,
          })),
          windows,
          framesSampled: frames.map((f) => ({
            timestampSec: f.timestampSec,
            jpegBytes: f.bytes,
          })),
          transcript:
            transcript && transcript.text
              ? {
                  text: transcript.text,
                  segments: transcript.segments,
                  language: transcript.language ?? null,
                }
              : null,
          transcriptError,
          visionModel: config.visionModel,
          ...parseAnalysis(raw),
        }
        return JSON.stringify(evidence, null, 2)
      } catch (err) {
        return toolErrorMessage(err)
      }
    },
  }))
}

export function apply(ctx, config) {
  registerVideoProbe(ctx)
  registerVideoAnalyze(ctx, config)
  registerVideoAsk(ctx, config)
}
