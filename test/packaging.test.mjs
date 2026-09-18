// dsh-video-lens packaging contract: the manifest must never install a second
// copy of the host runtime into the user's profile.
//
// Why this test exists (regression guard for the 0.3.1 crash): 0.3.1 declared
// `"@deepseek-ai/dsh-tools": "0.1.0-rc.7"` as a normal dependency. Installing
// that package into a profile materialized an OLD dsh-tools next to the host's
// own runtime, and the old copy imports symbols the newer host runtime no
// longer exports (`CallId` from `@deepseek-ai/dsh-llm`). The import failed at
// module-evaluation time, so the Loader entry could not be applied, the whole
// plugin tree failed, and the client could not start at all —
// `dsh-plugin-desktop: plugin tree failed to load: ... AggregateError` on
// DSH Desktop 2.0.5 (upstream core 0.1.5-rc.2), reported on Windows.
//
// The rule: official runtime packages are provided by the host (the DSH
// installation / the Desktop installation) and reach a profile-local plugin
// through the Loader's host anchor. They belong in `peerDependencies` with
// `peerDependenciesMeta.optional = true` — optional, so pnpm never
// auto-installs a competing copy (pnpm skips optional peers even with
// `autoInstallPeers: true`, which DSH profiles turn off anyway).
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- host runtime must never be a hard dependency -------------------------

/** Runtime packages the host process already loads; a profile copy can shadow it. */
const HOST_RUNTIME = /^@deepseek-ai\/(cordis|dsh(-|$)|cosmokit)/
/** Leaf helper libraries with a stable public API that plugins legitimately bundle. */
const ALLOWED_DEPENDENCIES = new Set(['@deepseek-ai/schemastery'])

const dependencies = Object.keys(manifest.dependencies ?? {})
const forbidden = dependencies.filter((name) => HOST_RUNTIME.test(name) && !ALLOWED_DEPENDENCIES.has(name))
check(
  'no host runtime package is a hard dependency',
  forbidden.length === 0,
  forbidden.length > 0 ? `move to optional peerDependencies: ${forbidden.join(', ')}` : undefined,
)

const peers = manifest.peerDependencies ?? {}
const peerMeta = manifest.peerDependenciesMeta ?? {}
check('@deepseek-ai/dsh-tools is declared as a peer', typeof peers['@deepseek-ai/dsh-tools'] === 'string', peers['@deepseek-ai/dsh-tools'])
check(
  '@deepseek-ai/dsh-tools peer is optional (pnpm never installs it)',
  peerMeta['@deepseek-ai/dsh-tools']?.optional === true,
)
check(
  'the dsh-tools peer range accepts the host version, not one exact rc',
  peers['@deepseek-ai/dsh-tools'] !== undefined && !/^[0-9]/.test(peers['@deepseek-ai/dsh-tools']),
  peers['@deepseek-ai/dsh-tools'],
)

// --- publishable shape ----------------------------------------------------

check('version is a stable release (no prerelease tag)', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version)
check('package is ESM with an entry point', manifest.type === 'module' && typeof manifest.main === 'string')

const patchPath = manifest.dsh?.bundle?.patch
check('dsh.bundle.patch is declared', typeof patchPath === 'string', patchPath)
check(
  'the declared bundle patch file exists',
  typeof patchPath === 'string' && existsSync(join(root, patchPath)),
)

// The Loader resolves every published entry of the bundle; a file that is
// missing from the tarball turns into a boot failure for the whole profile.
const published = new Set(manifest.files ?? [])
const required = ['src', 'cordis.patch.yml', 'LICENSE', 'README.md', 'SECURITY.md']
const missing = required.filter((entry) => !published.has(entry))
check('every shipped artifact is listed in files[]', missing.length === 0, missing.join(', '))

check(
  'the entry module exists and is published',
  existsSync(join(root, manifest.main)) && [...published].some((entry) => manifest.main.startsWith(entry)),
  manifest.main,
)

const passed = results.filter((r) => r.ok).length
console.log(`\nRESULT: ${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
