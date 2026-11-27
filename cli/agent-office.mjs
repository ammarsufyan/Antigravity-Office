#!/usr/bin/env node
/**
 * agent-office.mjs - the `antigravity-office` CLI: run and manage Antigravity Office.
 *
 *   antigravity-office [start]          serve the built UI + server and open it (default)
 *     --detach, -d                      run in the background ($AGENT_OFFICE_HOME/server.log)
 *     --no-open                         print the link, open no browser
 *   antigravity-office open [--print]   open (or print) the office link again
 *   antigravity-office stop [--force]   stop the running server / watcher by pid files
 *   antigravity-office install-hooks    register Antigravity hooks in ~/.gemini/config/hooks.json
 *   antigravity-office uninstall-hooks  remove them cleanly
 *   antigravity-office doctor [--json] [--no-color]
 *   antigravity-office --version | --help
 *   --port <n> on any command sets AGENT_OFFICE_PORT for it
 *
 * Cross-platform pure Node.js (Windows, macOS, Linux — no bash/python3/curl needed).
 */

import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openOffice } from '../scripts/open-office.mjs'
import { COMMANDS as CHECKOUT_COMMANDS, formatReport, MIN_NODE_MAJOR, runDoctor } from '../scripts/doctor.mjs'
import { main as toolHooks, TOOL_IDS } from '../scripts/install-tool-hooks.mjs'
import { readPort } from '../server/config.js'

/** The package root: the directory holding package.json, server/, dist/ and hooks/. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Files copied to $AGENT_OFFICE_HOME/hooks when installing outside a git checkout. */
export const HOOK_FILES = ['antigravity-relay.mjs']

/** Flags each command accepts (besides the global --port, --help and --version). */
export const COMMAND_FLAGS = {
  start: ['--detach', '-d', '--no-open'],
  open: ['--print'],
  stop: ['--force', '-f'],
  'install-hooks': [],
  'uninstall-hooks': [],
  doctor: ['--json', '--no-color'],
}

const HEALTH_WAIT_MS = 15_000
const HEALTH_POLL_MS = 200
const PROBE_TIMEOUT_MS = 1_000
const STOP_GRACE_MS = 5_000

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = new Set()
  const positional = []
  let port
  let tool
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tool' || arg.startsWith('--tool=')) {
      tool = arg === '--tool' ? (argv[++i] ?? '') : arg.slice('--tool='.length)
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      const n = /^\d{1,5}$/.test(raw ?? '') ? Number(raw) : NaN
      if (!(n >= 1 && n <= 65535)) return { command: 'help', flags, error: `--port needs a port number (1-65535), got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}` }
      port = n
    } else if (arg.startsWith('-')) {
      flags.add(arg)
    } else {
      positional.push(arg)
    }
  }
  if (flags.has('--help') || flags.has('-h') || positional[0] === 'help') return { command: 'help', flags, port }
  if (flags.has('--version') || flags.has('-v') || flags.has('-V')) return { command: 'version', flags, port }

  const command = positional[0] ?? 'start'
  if (!Object.hasOwn(COMMAND_FLAGS, command)) return { command: 'help', flags, port, error: `Unknown command: ${command}` }
  if (positional.length > 1) return { command, flags, port, error: `Unexpected argument: ${positional[1]}` }
  const unknown = [...flags].find(f => !COMMAND_FLAGS[command].includes(f))
  if (unknown) return { command, flags, port, error: `Unknown option for ${command}: ${unknown}` }
  if (tool !== undefined) {
    if (command !== 'install-hooks' && command !== 'uninstall-hooks') return { command, flags, port, error: '--tool works with install-hooks and uninstall-hooks only' }
    if (!TOOL_IDS.includes(tool)) return { command, flags, port, error: `--tool needs one of: ${TOOL_IDS.join(', ')}${tool ? ` (got ${JSON.stringify(tool)})` : ''}` }
    return { command, flags, port, tool }
  }
  return { command, flags, port }
}

export function usage(bin) {
  return `Usage: ${bin} [command] [options]

Commands:
  start               serve Antigravity Office (server + built UI) and open it (default)
      --detach, -d      run in the background; stop it with: ${bin} stop
      --no-open         print the office link, open no browser
  open [--print]      open the office link again (another browser), or print it
  stop                stop the running office server and watcher
  install-hooks       connect Antigravity (~/.gemini/config/hooks.json)
  uninstall-hooks     remove Antigravity Office hooks
  doctor [--json]     check node, Antigravity hooks, agy CLI, server and token

Options:
  --port <n>          the office port (default 3334, or AGENT_OFFICE_PORT)
  -h, --help          this text
  -v, --version       the version

Environment: AGENT_OFFICE_PORT, AGENT_OFFICE_HOME (default ~/.agent-office).
Needs Node ${MIN_NODE_MAJOR}+.`
}

// ---------------------------------------------------------------------------
// Where the hooks live
// ---------------------------------------------------------------------------

export function isCheckout(root, exists = existsSync) {
  return exists(join(root, '.git')) && !root.split(sep).includes('node_modules')
}

export function resolveHooksDir({ root, officeHome, exists = existsSync }) {
  if (isCheckout(root, exists)) return { dir: join(root, 'hooks'), copy: false }
  return { dir: join(officeHome, 'hooks'), copy: true }
}

export function copyHooks(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const written = []
  for (const name of HOOK_FILES) {
    const dest = join(destDir, name)
    const tmp = join(destDir, `.${name}.${process.pid}.tmp`)
    writeFileSync(tmp, readFileSync(join(srcDir, name)))
    if (process.platform !== 'win32') chmodSync(tmp, 0o644)
    renameSync(tmp, dest)
    written.push(dest)
  }
  return written
}

export function npxCommands(bin) {
  return {
    ...CHECKOUT_COMMANDS,
    install: `${bin} install-hooks`,
    uninstall: `${bin} uninstall-hooks`,
    start: bin,
    startAlt: `${bin} start --detach`,
    dev: null,
    open: `${bin} open`,
    distMissing: 'this install has no dist/ — reinstall the package',
    restoreHooks: `${bin} install-hooks copies it back`,
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function readPackage(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function answers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function dropPidFile(file, pid) {
  try {
    if (readFileSync(file, 'utf8').trim() === String(pid)) unlinkSync(file)
  } catch {}
}

async function start(ctx, { detach, open }) {
  const { root, env, out, err, bin } = ctx
  const port = readPort(env, { warn: m => err.write(`${m}\n`) })
  const uiDir = env.AGENT_OFFICE_UI_DIR || join(root, 'dist')
  if (!existsSync(join(uiDir, 'index.html'))) {
    err.write(`The office UI is not built: ${join(uiDir, 'index.html')} is missing.\n`)
    err.write(isCheckout(root) ? 'Run npm run build first.\n' : 'This install of the package is incomplete; reinstall it.\n')
    return 1
  }

  if (await answers(port)) {
    out.write(`An office is already answering on port ${port}.\n`)
    return openOffice({ env, print: !open, out, err })
  }

  mkdirSync(ctx.officeHome, { recursive: true, mode: 0o700 })
  const serverEnv = { ...env }
  if (!isCheckout(root) && !serverEnv.AGENT_OFFICE_CONFIG_DIR) serverEnv.AGENT_OFFICE_CONFIG_DIR = ctx.officeHome

  const logFile = join(ctx.officeHome, 'server.log')
  let logFd = null
  if (detach) {
    logFd = openSync(logFile, 'a', 0o600)
    if (process.platform !== 'win32') chmodSync(logFile, 0o600)
  }
  // On Unix, detached gives the server its own process group so Ctrl+C reaches
  // only this CLI. On Windows, detached: true sets CREATE_NEW_CONSOLE, which
  // hides foreground stdout/stderr in a separate window.
  const child = spawn(process.execPath, [join(root, 'server', 'index.js')], {
    env: serverEnv,
    stdio: ['ignore', detach ? logFd : 'inherit', detach ? logFd : 'inherit'],
    detached: process.platform !== 'win32' || detach,
    windowsHide: detach,
  })
  if (logFd !== null) closeSync(logFd)
  const pidFile = join(ctx.officeHome, 'server.pid')
  writeFileSync(pidFile, `${child.pid}\n`)

  let exited = null
  const exitedPromise = new Promise(res => child.once('exit', (code, signal) => { exited = { code, signal }; res(exited) }))
  child.once('error', e => { err.write(`Could not start the server: ${e.message}\n`); exited = { code: 1 } })

  const deadline = Date.now() + HEALTH_WAIT_MS
  let up = false
  while (!exited && Date.now() < deadline) {
    if (await answers(port)) { up = true; break }
    await sleep(HEALTH_POLL_MS)
  }
  if (!up) {
    if (!exited) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM') } catch { try { child.kill() } catch {} } }
    dropPidFile(pidFile, child.pid)
    err.write(exited
      ? `The office server exited during start (code ${exited.code ?? exited.signal})${detach ? ` — see ${logFile}` : ''}.\n`
      : `The office server did not answer on port ${port} within ${HEALTH_WAIT_MS / 1000}s; stopped it.\n`)
    return 1
  }

  await openOffice({ env, print: !open, out, err })

  if (detach) {
    child.unref()
    out.write(`The office runs in the background (pid ${child.pid}, log ${logFile}).\nStop it with: ${bin} stop\n`)
    return 0
  }

  out.write('Press Ctrl+C to stop the office.\n')
  const stopChild = () => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM') } catch { try { child.kill() } catch {} }
    setTimeout(() => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') } catch {} }, STOP_GRACE_MS).unref()
  }
  let interrupted = false
  const onSignal = () => { interrupted = true; out.write('\nStopping the office...\n'); stopChild() }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const result = await exitedPromise
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  dropPidFile(pidFile, child.pid)
  if (interrupted) return 130
  return result.signal ? 0 : (result.code ?? 0)
}

/** Cross-platform stop by pid files (Windows, macOS, Linux). */
async function stopServer(ctx) {
  let stopped = 0
  for (const [label, file] of [['Server', 'server.pid'], ['Chat watcher', 'chat-watcher.pid'], ['Vite dev server', 'vite.pid']]) {
    const full = join(ctx.officeHome, file)
    if (!existsSync(full)) continue
    const pid = Number(readFileSync(full, 'utf8').trim())
    try { unlinkSync(full) } catch {}
    if (!Number.isInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 'SIGTERM')
      // Wait briefly for the process to release its port before returning
      const deadline = Date.now() + STOP_GRACE_MS
      while (Date.now() < deadline) {
        try { process.kill(pid, 0) } catch { break }
        await sleep(50)
      }
      ctx.out.write(`${label} stopped (pid ${pid})\n`)
      stopped++
    } catch {}
  }
  if (!stopped) ctx.out.write('Nothing was running.\n')
  return 0
}

function installHooks(ctx) {
  const { dir, copy } = resolveHooksDir({ root: ctx.root, officeHome: ctx.officeHome })
  if (copy) {
    copyHooks(join(ctx.root, 'hooks'), dir)
    ctx.out.write(`Copied the hook scripts to ${dir} (a path that outlives the npx cache).\n`)
  }
  return toolHooks(['--tool', 'antigravity', '--hooks-dir', dir], { out: ctx.out, err: ctx.err, home: ctx.env.HOME || ctx.env.USERPROFILE || homedir() })
}

function uninstallHooks(ctx) {
  const { dir, copy } = resolveHooksDir({ root: ctx.root, officeHome: ctx.officeHome })
  const code = toolHooks(['--uninstall', '--tool', 'antigravity', '--hooks-dir', dir], { out: ctx.out, err: ctx.err, home: ctx.env.HOME || ctx.env.USERPROFILE || homedir() })
  if (code === 0 && copy && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    ctx.out.write(`Removed the hook scripts in ${dir}.\n`)
  }
  return code
}

async function doctor(ctx, flags) {
  const { dir, copy } = resolveHooksDir({ root: ctx.root, officeHome: ctx.officeHome })
  const report = await runDoctor({ env: ctx.env, root: ctx.root, hooksDir: dir, commands: copy ? npxCommands(ctx.bin) : CHECKOUT_COMMANDS })
  if (flags.has('--json')) {
    ctx.out.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const color = !!ctx.out.isTTY && !ctx.env.NO_COLOR && !flags.has('--no-color')
    ctx.out.write(`${formatReport(report, { color }).join('\n')}\n`)
  }
  return report.ok ? 0 : 1
}

export async function main(argv, { root = PACKAGE_ROOT, env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const pkg = readPackage(root)
  const bin = `npx ${pkg.name ?? 'antigravity-office'}`
  const parsed = parseArgs(argv)
  if (parsed.error) {
    err.write(`${parsed.error}\n\n${usage(bin)}\n`)
    return 2
  }
  if (parsed.command === 'help') { out.write(`${usage(bin)}\n`); return 0 }
  if (parsed.command === 'version') { out.write(`${pkg.version ?? 'unknown'}\n`); return 0 }

  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE_MAJOR) {
    err.write(`Antigravity Office needs Node ${MIN_NODE_MAJOR} or newer (this is ${process.versions.node}).\n`)
    return 1
  }

  const runEnv = parsed.port ? { ...env, AGENT_OFFICE_PORT: String(parsed.port) } : env
  const officeHome = runEnv.AGENT_OFFICE_HOME || join(runEnv.HOME || runEnv.USERPROFILE || homedir(), '.agent-office')
  const ctx = { root, env: runEnv, out, err, bin, officeHome }
  const flags = parsed.flags

  switch (parsed.command) {
    case 'start':
      return start(ctx, { detach: flags.has('--detach') || flags.has('-d'), open: !flags.has('--no-open') })
    case 'open':
      return openOffice({ env: runEnv, print: flags.has('--print'), out, err })
    case 'stop':
      return stopServer(ctx)
    case 'install-hooks':
      return installHooks(ctx)
    case 'uninstall-hooks':
      return uninstallHooks(ctx)
    case 'doctor':
      return doctor(ctx, flags)
  }
  return 2
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => {
    process.stderr.write(`${e?.stack ?? e}\n`)
    process.exit(1)
  })
}
