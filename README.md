# dsh-video-lens

**Video understanding for DeepSeek Harness — give text-only agents eyes and ears on video.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that lets text-only LLM agents understand local video files. It provides two tools:

| Tool | What it does |
|---|---|
| `video_probe` | Cheap, instant metadata via `ffprobe`: container, duration, resolution, fps, codecs, audio tracks, subtitles. |
| `video_analyze` | Content understanding: **scene-change-aware frame sampling** (`ffmpeg scdet`), **optional ASR transcript** (speech with timestamps), fused with any OpenAI-compatible vision model into structured evidence JSON. |
| `video_ask` | **Time-anchored Q&A**: parses explicit time references ("at 3:20", "第2分钟") or locates relevant speech via transcript keyword matching, re-samples frames from the matched windows, and answers with grounded evidence (answer + confidence + supporting timestamps). |

> v0.3.2. The plugin never locks you into a provider: vision and ASR are both OpenAI-compatible endpoints configured via `baseUrl` + `model` + key env var.

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
    "dsh-video-lens": "^0.3"
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

> **Do not install the host runtime yourself.** `@deepseek-ai/dsh-tools` is declared as an **optional peer**: the plugin always uses the `dsh-tools` that already ships with your DSH installation / DSH Desktop. Adding it to your profile as a dependency — or pinning one exact `-rc` version, which is what 0.3.1 did — installs a second, older runtime next to the host's, makes the Loader entry fail to import, and takes the whole plugin tree (and the app) down with it.

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
- Host runtime is **not pinned**: `@deepseek-ai/dsh-tools` is an optional peer resolved from the host installation, so the plugin follows the core it is loaded by (verified against core `0.1.0-rc.7` and `0.1.5-rc.2`, the upstream version DSH Desktop 2.0.5 pins).
- Node ≥ 20 (uses `AbortSignal.any` / built-in `fetch` / `FormData`).
- ffmpeg ≥ 6.0 for `scdet`; older versions degrade to uniform sampling.
- macOS verified. Windows: the 0.3.1 boot failure reported on Windows was **not** platform-specific — it was the pinned old `dsh-tools` runtime (see Troubleshooting); the code paths themselves are OS-neutral (`ffmpeg`/`ffprobe` are spawned via argv, no shell).

## Troubleshooting

**`dsh-plugin-desktop: plugin tree failed to load: failed to apply loader entry include (cordis:include): AggregateError: loader entries failed to apply` — the client no longer starts.**

0.3.1 hit this on DSH Desktop 2.0.5. The full error underneath is an import failure of the plugin (or of the host `tools` entry):

```
failed to import loader entry video-lens (dsh-video-lens): The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'CallId'
  [cause]: profiles/<name>/node_modules/@deepseek-ai/dsh-tools/lib/index.js:4
```

Cause: 0.3.1 pinned `@deepseek-ai/dsh-tools@0.1.0-rc.7`, so the profile got a second, older `dsh-tools` while the host ran a newer core (`0.1.5-rc.2`). Any failing Loader entry fails the whole tree, so the app cannot boot until the plugin is removed.

Recovery (0.3.1 installed and the app will not start):

1. Use the client's Recovery page to return to the last healthy profile, **or** remove the plugin from the profile: `dsh plugin --profile <name> remove dsh-video-lens` (Desktop: run that in its terminal).
2. Install `dsh-video-lens@^0.3.2`, where the host runtime is an optional peer and nothing is installed into the profile.

## Testing

```bash
npm test                                     # packaging + unit + network + e2e (needs ffmpeg)
node test/host-boot.test.mjs latest          # boot a real host with the plugin mounted
node test/host-boot.test.mjs 0.1.0-rc.7      # exactly one core version
node test/host-boot.test.mjs desktop-stable  # the upstream core DSH Desktop currently pins
```

- `test/packaging.test.mjs` — manifest contract: official host runtime packages (`@deepseek-ai/dsh-*`) must stay **optional peers**, never installed dependencies, and the published bundle patch / entry must resolve.
- `test/host-boot.test.mjs` — end-to-end guard: packs the plugin, installs it into a throwaway profile under the DSH Desktop profile contract (`nodeLinker: hoisted`, `autoInstallPeers: false`), then boots that profile with a real DSH host and requires the Web surface to come up — while asserting the profile installed **no** host runtime package. Needs `pnpm` on PATH (or `PNPM_BIN`) and network access; no API keys and no ffmpeg. CI runs it for `latest`, `0.1.0-rc.7`, and the core currently pinned by DSH Desktop.

## Uninstall

1. Remove `dsh-video-lens` from `dsh.profile.bundles` in your profile `package.json`.
2. Remove the dependency: `pnpm remove dsh-video-lens` (npm install) — or delete the `link:` entry if you installed from source — then reinstall the profile.

## Roadmap

- v1.0: frame caching by file hash, evaluation table in README (5 video types × metrics), publish to npm (in progress).
- Beyond: native video-input models as an optional fast path when the configured VLM supports them.

## License

MIT — see [LICENSE](LICENSE).
