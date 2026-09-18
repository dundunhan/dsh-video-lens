// dsh-video-lens host boot smoke: pack the plugin, install it into a throwaway
// DSH profile the way a real user (and DSH Desktop) does, then boot that
// profile with a real DSH host and require the plugin tree to load.
//
// Why this exists: `test/packaging.test.mjs` only checks the manifest. The
// 0.3.1 crash was invisible to every manifest check — the plugin declared a
// pinned host runtime, the profile installed a second, OLDER copy next to the
// host's own, and the Loader entry then failed to import. Only booting a real
// host reproduces that, so this script boots one for every supported core:
//
//   node test/host-boot.test.mjs latest           # npm dist-tag `latest`
//   node test/host-boot.test.mjs 0.1.0-rc.7       # one explicit core version
//   node test/host-boot.test.mjs desktop-stable   # upstream core DSH Desktop pins
//
// Requirements: Node >= 20, `pnpm` on PATH (or PNPM_BIN), network access, and
// a writable temp dir. No API keys and no ffmpeg are needed: the profile only
// has to boot, it never calls a tool.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const requested = process.argv[2] ?? 'latest'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const PNPM = process.env.PNPM_BIN ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
const INSTALL_TIMEOUT_MS = 600_000
const BOOT_TIMEOUT_MS = 180_000
/** The client that reported the 0.3.1 crash pins its upstream core here. */
const DESKTOP_UPSTREAM_MANIFEST = 'https://raw.githubusercontent.com/anywhere-labs/dsh-desktop/master/upstream.json'
/** A Loader entry that cannot be applied fails the whole tree — the exact strings users see. */
const FAILURE_MARKERS = [
  'plugin tree failed to load',
  'failed to apply loader entry',
  'failed to import loader entry',
  'loader entries failed to apply',
]

function log(message) {
  console.log(`[host-smoke] ${message}`)
}

function fail(message) {
  console.error(`[host-smoke] FAIL — ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

/** Run one command to completion, capturing stdout, stderr, and their merge. */
function run(command, args, { cwd, env, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs} ms\n${stdout}${stderr}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, output: `${stdout}${stderr}` }) })
  })
}

/** Run one command and fail the smoke test when it does not exit cleanly. */
async function mustRun(command, args, options) {
  const result = await run(command, args, options)
  if (result.code !== 0) fail(`${command} ${args.join(' ')} exited with ${result.code}\n${result.output}`)
  return result
}

/** Resolve the requested core spec to one exact published version. */
async function resolveCoreVersion(spec, npmEnv) {
  if (spec === 'desktop-stable') {
    try {
      const response = await fetch(DESKTOP_UPSTREAM_MANIFEST, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = await response.json()
      const version = manifest?.channels?.stable?.runtimePackageVersion
      if (typeof version !== 'string' || version.length === 0) throw new Error('no channels.stable.runtimePackageVersion')
      log(`DSH Desktop pins upstream core ${version} (${DESKTOP_UPSTREAM_MANIFEST})`)
      return version
    } catch (error) {
      log(`SKIP desktop-stable: cannot read ${DESKTOP_UPSTREAM_MANIFEST} — ${error.message}`)
      return undefined
    }
  }
  if (spec === 'latest' || spec === 'next') {
    const { stdout } = await mustRun(NPM, ['view', `@deepseek-ai/dsh@${spec}`, 'version'], { env: npmEnv })
    const version = stdout.trim().split('\n').pop()
    log(`npm dist-tag ${spec} resolves to core ${version}`)
    return version
  }
  return spec
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * Boot one profile and wait until the Web surface reports its URL. Resolves the
 * boot log on success and throws with the captured output on any failure.
 */
function bootProfile({ binPath, homeDir, port, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, '--profile', 'smoke', '--port', String(port)], {
      env: { ...env, DSH_HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      if (error) reject(error)
      else resolve(output)
    }
    const timer = setTimeout(
      () => finish(new Error(`boot did not report a Web URL within ${BOOT_TIMEOUT_MS} ms\n${output}`)),
      BOOT_TIMEOUT_MS,
    )
    const onChunk = (chunk) => {
      output += chunk
      if (/dsh web:\s+https?:\/\//u.test(output)) return finish()
      const marker = FAILURE_MARKERS.find((candidate) => output.includes(candidate))
      if (marker !== undefined) finish(new Error(`host reported "${marker}"\n${output}`))
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', (error) => finish(error))
    child.on('close', (code) => finish(new Error(`host exited with ${code} before serving\n${output}`)))
  })
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-video-lens-smoke-'))
  const npmEnv = { ...process.env, npm_config_cache: join(temp, 'npm-cache') }
  try {
    const version = await resolveCoreVersion(requested, npmEnv)
    if (version === undefined) {
      log(`RESULT: host boot smoke (${requested}) skipped`)
      return
    }
    log(`core ${version} — packed plugin, throwaway profile, real host boot`)

    // 1. Pack the plugin exactly as npm would publish it.
    const packDir = join(temp, 'pack')
    await mkdir(packDir, { recursive: true })
    const packOutput = await mustRun(NPM, ['pack', '--json', '--pack-destination', packDir, root], { env: npmEnv })
    const { filename } = JSON.parse(packOutput.stdout)[0]
    const tarball = join(packDir, filename)
    await access(tarball)
    log(`packed ${filename}`)

    // 2. Build the profile the way DSH Desktop builds one (hoisted linker, no
    //    peer auto-install), then install the plugin into it.
    const homeDir = join(temp, 'home')
    const profileDir = join(homeDir, 'profiles', 'smoke')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-smoke',
      private: true,
      dependencies: { 'dsh-video-lens': `file:${tarball}` },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-video-lens'],
        },
      },
    }, null, 2)}\n`)
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    const pnpmInstall = await run(PNPM, ['install', '--reporter=append-only'], { cwd: profileDir, env: npmEnv })
    if (pnpmInstall.code !== 0) {
      // The most common environment failure is pnpm outrunning Node (pnpm 11
      // needs Node >= 22.13 for node:sqlite), which is not a plugin defect —
      // say so instead of only dumping the pnpm stack.
      const hint = /node:sqlite|requires at least Node/u.test(pnpmInstall.output)
        ? `\nhint: this pnpm is too new for ${process.version} — pnpm 11 requires Node >= 22.13 while the plugin itself supports Node >= 20. Run this leg on Node >= 22.13, or point PNPM_BIN at an older pnpm.`
        : ''
      fail(`${PNPM} install exited with ${pnpmInstall.code}${hint}\n${pnpmInstall.output}`)
    }

    const installed = JSON.parse(await readFile(join(profileDir, 'node_modules', 'dsh-video-lens', 'package.json'), 'utf8'))
    log(`profile installed dsh-video-lens@${installed.version}`)

    // 3. Guard the actual root cause: a profile copy of the host runtime shadows
    //    the host's own and takes the plugin tree down with it.
    const scopedDir = join(profileDir, 'node_modules', '@deepseek-ai')
    const shadowing = existsSync(scopedDir)
      ? (await readdir(scopedDir)).filter((name) => /^dsh-/u.test(name))
      : []
    if (shadowing.length > 0) {
      fail(`profile installed host runtime packages ${shadowing.join(', ')} — official @deepseek-ai/dsh-* packages must stay optional peers`)
    }

    // 4. Install the real host and boot the profile with it.
    //    pnpm installs the host too: it resolves the ~200-package core graph in
    //    seconds, where npm's resolver can spend ten minutes on an older
    //    prerelease graph and, with `--legacy-peer-deps`, leaves peer-provided
    //    packages missing (`@deepseek-ai/cordis-plugin-group`) so the host
    //    cannot start. The Profile install above is what must stay faithful to
    //    the Desktop contract; how the host's own tree is materialized is not.
    const hostDir = join(temp, 'host')
    await mkdir(hostDir, { recursive: true })
    await writeFile(join(hostDir, 'package.json'), `${JSON.stringify({ name: 'dsh-host-smoke', private: true }, null, 2)}\n`)
    // strictDepBuilds: false — the host's native build scripts (node-pty,
    // koffi, subprocess-local, ...) are irrelevant to mounting a profile and
    // serving the Web surface, and pnpm 11 otherwise fails the install for
    // skipping them.
    await writeFile(join(hostDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nstrictDepBuilds: false\n')
    await mustRun(PNPM, ['add', `@deepseek-ai/dsh@${version}`, '--reporter=append-only'], { cwd: hostDir, env: npmEnv })
    const binPath = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await access(binPath)
    const port = await freePort()
    log(`booting core ${version} on 127.0.0.1:${port}`)
    const bootLog = await bootProfile({ binPath, homeDir, port, env: npmEnv })

    const url = bootLog.match(/dsh web:\s+(https?:\/\/\S+)/u)?.[1] ?? '(url not parsed)'
    console.log(bootLog.trimEnd())
    log(`PASS — core ${version} booted with the plugin mounted (${url})`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

try {
  await main()
  if (process.exitCode === undefined) log(`RESULT: host boot smoke (${requested}) passed`)
} catch (error) {
  if (process.exitCode === undefined) process.exitCode = 1
  console.error(`[host-smoke] ${error instanceof Error ? error.message : String(error)}`)
}
