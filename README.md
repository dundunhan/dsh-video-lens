# dsh-video-lens

**Video understanding for DeepSeek Harness — give text-only agents eyes and ears on video.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that lets text-only LLM agents understand local video files. It provides two tools:

| Tool | What it does |
|---|---|
| `video_probe` | Cheap, instant metadata via `ffprobe`: container, duration, resolution, fps, codecs, audio tracks, subtitles. |
| `video_analyze` | Content understanding: **scene-change-aware frame sampling** (`ffmpeg scdet`), **optional ASR transcript** (speech with timestamps), fused with any OpenAI-compatible vision model into structured evidence JSON. |
| `video_ask` | **Time-anchored Q&A**: parses explicit time references ("at 3:20", "第2分钟") or locates relevant speech via transcript keyword matching, re-samples frames from the matched windows, and answers with grounded evidence (answer + confidence + supporting timestamps). |

> v0.3.0. The plugin never locks you into a provider: vision and ASR are both OpenAI-compatible endpoints configured via `baseUrl` + `model` + key env var.

## How it works

```
video file ──► video_probe ──► ffprobe ──► compact metadata JSON
           └─► video_analyze ──► scdet scene detection ──► shot boundaries
                                 ├─► ffmpeg frame sampling (one representative frame per shot, capped)
                                 ├─► ffmpeg audio extract ──► ASR transcript (timestamped)   [optional]
                                 └─► OpenAI-compatible vision API ──► evidence JSON
```

- Scene changes are detected with ffmpeg's `scdet` filter (ffmpeg ≥ 6.0). Videos without detectable cuts fall back to uniform midpoint sampling.
- ASR is **strictly additive**: if `asrApiKeyEnv` is unset or the provider fails, the visual analysis still completes and `transcript` is `null`.
- All media work is delegated to `ffmpeg`/`ffprobe` on `PATH` — no native decoding in the agent.

## Install

Prerequisites: Node.js ≥ 20, `ffmpeg` ≥ 6.0 (recommended) with `ffprobe` on PATH (`brew install ffmpeg` / `apt install ffmpeg`).

### Option A — npm (recommended)

```bash
# in your DSH profile directory (the one containing package.json)
pnpm add dsh-video-lens
```

### Option B — from source (development)

Clone the repo, then mount it into your DSH profile via a local link:

```bash
git clone https://github.com/dundunhan/dsh-video-lens.git
```

Either way, register the bundle in your profile's `package.json` — **this exact block is the full profile configuration**:

```json
{
  "dependencies": {
    "dsh-video-lens": "^0.3.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-video-lens"
      ]
    }
  }
}
```

Then export the keys and restart the profile:

```bash
export VIDEO_LENS_API_KEY=sk-...        # vision
export VIDEO_LENS_ASR_KEY=sk-...        # optional, ASR
```

## Configuration

All options are DSH config values:

| Key | Default | Meaning |
|---|---|---|
| `visionBaseUrl` | `https://api.siliconflow.cn/v1` | Vision endpoint (OpenAI-compatible) |
| `visionModel` | `Qwen/Qwen3-VL-8B-Instruct` | Vision model name |
| `visionApiKeyEnv` | `VIDEO_LENS_API_KEY` | Env var holding the vision key |
| `asrBaseUrl` | `https://api.siliconflow.cn/v1` | ASR endpoint (OpenAI-compatible `/audio/transcriptions`) |
| `asrModel` | `FunAudioLLM/SenseVoiceSmall` | ASR model name |
| `asrApiKeyEnv` | `VIDEO_LENS_ASR_KEY` | Env var holding the ASR key |
| `maxFrames` | `12` | Frame budget cap (1–max); actual count is duration-adaptive (~1 frame per 30s, denser for short videos) |
| `frameMaxWidth` | `768` | Max frame width; keeps payloads small |
| `frameQuality` | `4` | JPEG quality (ffmpeg `-q:v`) |
| `sceneThreshold` | `10` | `scdet` threshold (0–100); higher = fewer cuts |
| `askPaddingSec` | `2` | `video_ask` window padding around matched transcript segments |
| `vlmMaxTokens` | `1500` | Vision model max output tokens |
| `vlmTimeoutMs` | `90000` | Vision call timeout |
| `asrTimeoutMs` | `120000` | ASR call timeout |

## Usage

Ask the agent:

> "What's in /tmp/demo.mp4?"

The agent calls `video_probe` first, then `video_analyze`. Evidence includes:

```json
{
  "metadata": { "container": "mov,mp4,m4a,3gp,3g2,mj2", "durationSec": 268.4, "...": "..." },
  "shots": [{ "timeSec": 12.3, "score": 45.2 }],
  "framesSampled": [{ "timestampSec": 5.5, "jpegBytes": 12345 }],
  "transcript": {
    "text": "…",
    "segments": [{ "start": 0.0, "end": 2.4, "text": "…" }],
    "language": "zh"
  },
  "visionModel": "Qwen/Qwen3-VL-8B-Instruct",
  "analysis": { "overall_summary": "…", "timeline": [{"timestamp_sec": 5.5, "description": "…"}], "on_screen_text": "…", "visual_style": "…", "notable_moments": "…" }
}
```

## Permissions & security

> Read this before using or redistributing. DSH plugins run in the **host process as trusted code** and there is **no official plugin review** — self-review is on the author. See [SECURITY.md](SECURITY.md).

**What this plugin does**

- **Reads**: any local file path the agent passes to its tools (via `ffprobe`/`ffmpeg`).
- **Executes**: `ffprobe` and `ffmpeg` from `PATH` (never a shell — argv arrays only).
- **Network**: one outbound call per `video_analyze` to the configured `visionBaseUrl` (frames + vision key), and optionally one to `asrBaseUrl` (audio + ASR key).
- **Does not**: execute shells, eval code, phone home, auto-update, or read files on its own.

**Operator responsibilities**

- Keys are only as safe as the endpoints they are sent to — configure only endpoints you trust.
- The real access boundary is the DSH host sandbox; the plugin's readability check is a UX guard, not a security boundary.
- Payload sizes are bounded: `maxFrames` × ~100–300 KB (768px JPEG) per analysis call.

## Compatibility

- Tested with DSH profile bundles `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`.
- Node ≥ 20 (uses `AbortSignal.any` / built-in `fetch` / `FormData`).
- ffmpeg ≥ 6.0 for `scdet`; older versions degrade to uniform sampling.
- macOS / Linux tested; Windows untested.

## Uninstall

1. Remove `dsh-video-lens` from `dsh.profile.bundles` in your profile `package.json`.
2. Remove the dependency: `pnpm remove dsh-video-lens` (npm install) — or delete the `link:` entry if you installed from source — then reinstall the profile.

## Roadmap

- v1.0: frame caching by file hash, test suite + CI, npm publish, evaluation table in README.
- Beyond: native video-input models as an optional fast path when the configured VLM supports them.

## License

MIT — see [LICENSE](LICENSE).
