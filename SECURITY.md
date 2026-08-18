# Security

## Position in the DSH trust model

- DSH plugins run inside the **host process as trusted code** and there is **no official plugin review**. Distribution is community-driven (self-hosted repos tagged `dsh-plugin`).
- This document is the author's self-review and operator-facing contract. It is not a guarantee.

## Author's self-review (what this plugin does)

| Scope | Details |
|---|---|
| Reads | Only file paths the agent passes to `video_probe` / `video_analyze` |
| Executes | `ffprobe` and `ffmpeg` from `PATH`, always via `execFile` with argv arrays — **no shell, no string interpolation** (no command injection) |
| Network | Exactly one call to the configured `visionBaseUrl` per `video_analyze` (frames + vision key); optionally one to `asrBaseUrl` (audio + ASR key). No telemetry, no auto-update, no other endpoints |
| Writes | Temp files only: `mkdtemp` under the OS temp dir, removed in `finally` |
| Keys | Read from env vars at call time only; never persisted, never logged |

## Threat model & mitigations

| Threat | Mitigation |
|---|---|
| Agent passes a path starting with `-` (ffmpeg option injection) | `assertSafePath` rejects basenames starting with `-` |
| Malicious/corrupt media hangs the tool | `AbortSignal.timeout` on every ffprobe/ffmpeg/fetch call, merged with the harness cancellation signal |
| Resource exhaustion from many parallel ffmpeg decoders | Extraction capped at 3 concurrent processes |
| Operator configures a hostile `visionBaseUrl`/`asrBaseUrl` (key exfiltration) | Keys are sent only to the configured endpoint — operators must only configure endpoints they trust |
| ASR key missing / provider down | `transcribe` resolves `null`; the visual path always completes |
| Temp-file leak on hard kill | `finally`-based cleanup; worst case a stray dir under OS temp |

## Operator checklist before deployment

- [ ] Only trust endpoints you control or have reviewed for `visionBaseUrl` / `asrBaseUrl`.
- [ ] Understand that plugin tools run with host permissions — the DSH fs sandbox is the real boundary.
- [ ] Pin the plugin version you have reviewed (`package.json`), rather than blindly updating.

## Reporting

This project has no bug bounty. Report issues in the repository's issue tracker; include the plugin version and, for security-sensitive findings, avoid pasting live API keys.
