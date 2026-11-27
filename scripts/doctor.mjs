#!/usr/bin/env node
/**
 * doctor.mjs — `npm run doctor`: why does nothing appear in Antigravity Office?
 *
 * One PASS / WARN / FAIL line per check, the install / uninstall / start
 * commands at the end, exit 1 when anything FAILed. Nothing here writes.
 *
 *   node         Node 22+ (required for built-in node:sqlite / better-sqlite3)
 *   hooks        ~/.gemini/config/hooks.json runs hooks/antigravity-relay.mjs
 *                for every event listed in root hooks.json, from a file that exists.
 *   agy          optional: `agy` CLI on PATH (used by chat-watcher for AI replies)
 *   server       GET http://127.0.0.1:$AGENT_OFFICE_PORT/health answers, and
 *                whether a hook has reached it since it started
 *   token        $AGENT_OFFICE_HOME/auth-token exists (and mode 0600 on POSIX)
 *   dist         the UI is built (npm run build); else Vite on :3333 is the way in
 *   hook files   hooks/antigravity-relay.mjs exists
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { targetFile } from './install-tool-hooks.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELAY_NAME = 'antigravity-relay.mjs'
const AGY_KEY = 'antigravity-office'
export const MIN_NODE_MAJOR = 22
export const DEFAULT_PORT = 3334

export const PASS = 'PASS'
export const WARN = 'WARN'
export const FAIL = 'FAIL'

export const COMMANDS = {
  install: 'npm run install-antigravity',
  uninstall: 'npm run uninstall-antigravity',
  start: 'npm run build && npm run start:antigravity',
  startAlt: 'npm run server',
  chatWatcher: 'npm run chat-watcher',
  dev: 'npm run dev',
  open: 'npm run open',
  restoreHooks: 'git pull to restore hooks/antigravity-relay.mjs',
  distMissing: 'npm run build for the one-port page, or npm run dev for the Vite dev server on :3333',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const result = (level, title, ...notes) => ({ level, title, notes: notes.filter(Boolean) })

/** { value } | { missing: true } | { error } */
function readJson(path) {
  if (!existsSync(path)) return { missing: true }
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Split a command string into words, honouring quotes and POSIX escapes. */
export function shellWords(command) {
  const words = []
  let cur = ''
  let quote = null
  let has = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) words.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) words.push(cur)
  return words
}

/** The path a hook command runs that ends in hooks/<name>, or null when not ours. */
export function scriptPathIn(command, name = RELAY_NAME) {
  if (typeof command !== 'string' || !command.includes(name)) return null
  return shellWords(command).find(w => basename(w) === name && basename(dirname(w)) === 'hooks') ?? null
}

function expandHome(p, home) {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p.replace(/^\$\{?HOME\}?(?=\/|$)/, home)
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

/** First executable `name` on PATH, or null. */
export function which(name, path = process.env.PATH ?? '') {
  const exts = process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(name) ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        accessSync(candidate, constants.F_OK)
        if (statSync(candidate).isFile()) return candidate
      } catch {}
    }
  }
  return null
}

export function formatSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`
  return `${Math.floor(h / 24)} d`
}

/** The Antigravity hook events registered by hooks.json at the repo root. */
export function expectedEvents(root = ROOT) {
  const { value } = readJson(join(root, 'hooks.json'))
  const block = value && typeof value === 'object' ? (value[AGY_KEY] ?? value.hooks ?? value) : null
  return block && typeof block === 'object' ? Object.keys(block) : ['SessionStart', 'PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop']
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0])
  if (major >= MIN_NODE_MAJOR) return result(PASS, `node v${version}`)
  return result(FAIL, `node v${version} — Antigravity Office needs Node ${MIN_NODE_MAJOR}+; install a current LTS`)
}

/** Inspect ~/.gemini/config/hooks.json for our antigravity-office block. */
export function inspectHooks(cfg, { events, relay, home }) {
  const block = cfg && typeof cfg === 'object' ? (cfg[AGY_KEY] ?? cfg['claude-office']) : null
  const perEvent = new Map()
  for (const event of events) {
    const raw = block && typeof block === 'object' ? block[event] : null
    const list = Array.isArray(raw) ? raw : []
    const entries = []
    for (const item of list) {
      const handlers = Array.isArray(item?.hooks) ? item.hooks : [item]
      for (const h of handlers) {
        const script = h && typeof h === 'object' ? scriptPathIn(h.command, RELAY_NAME) : null
        if (script === null) continue
        const path = expandHome(script, home)
        entries.push({ command: h.command, path, exists: existsSync(path), current: existsSync(path) && samePath(path, relay) })
      }
    }
    perEvent.set(event, entries)
  }
  const registered = events.filter(e => perEvent.get(e).length > 0)
  const missing = events.filter(e => perEvent.get(e).length === 0)
  const all = events.flatMap(e => perEvent.get(e))
  const dead = [...new Set(all.filter(x => !x.exists).map(x => x.path))]
  const foreign = [...new Set(all.filter(x => x.exists && !x.current).map(x => x.path))]
  const paths = [...new Set(all.map(x => x.path))]
  return { perEvent, registered, missing, dead, foreign, paths, any: registered.length > 0 }
}

export function checkHooks({ hooksPath, config, configState, events, relay, home, commands: C = COMMANDS }) {
  const out = []
  const hooks = inspectHooks(config, { events, relay, home })
  const n = events.length

  if (configState?.error) {
    out.push(result(FAIL, `hooks config: ${hooksPath} is not valid JSON (${configState.error}) — fix it, then ${C.install}`))
    return { results: out, hooks }
  }

  if (hooks.any) {
    const where = hooks.paths.length === 1 ? hooks.paths[0] : `${hooks.paths.length} different paths`
    if (hooks.dead.length) {
      out.push(result(FAIL, `hooks: ${n - hooks.missing.length}/${n} events registered in ${hooksPath}, but they run a file that does not exist: ${hooks.dead.join(', ')}`,
        `${C.install} repoints them at this checkout`))
    } else if (hooks.missing.length) {
      out.push(result(WARN, `hooks: ${hooks.registered.length}/${n} events run ${where} (missing: ${hooks.missing.join(', ')})`,
        `an older install — ${C.install} updates them`))
    } else {
      out.push(result(PASS, `hooks: ${n}/${n} events run ${where}`))
    }
    if (hooks.foreign.length) {
      out.push(result(WARN, `hooks: ${hooks.foreign.join(', ')} is not this checkout's hooks/${RELAY_NAME} (${relay})`,
        `fine if that copy is the one you mean to use; ${C.install} here repoints them`))
    }
  } else {
    const what = configState?.missing ? `${hooksPath} does not exist` : `nothing in ${hooksPath} runs hooks/${RELAY_NAME}`
    out.push(result(FAIL, `hooks: not installed — ${what}`, `${C.install} registers them`))
  }

  return { results: out, hooks }
}

export function checkAgy(path = process.env.PATH) {
  const found = which('agy', path)
  if (found) return result(PASS, `agy: ${found}`)
  return result(WARN, 'agy: not on PATH — visual office works fine, only optional chat-watcher AI replies need `agy`')
}

export async function checkServer({ port = DEFAULT_PORT, fetchImpl = globalThis.fetch, timeoutMs = 2000, now = Date.now(), commands: C = COMMANDS } = {}) {
  const url = `http://127.0.0.1:${port}/health`
  let body
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { results: [result(WARN, `server: ${url} answered HTTP ${res.status} — something else is listening on :${port}?`)], up: false }
    body = await res.json()
  } catch {
    return {
      results: [result(WARN, `server: nothing answers on ${url} — the office server is not running`, `start it: ${C.start}  (or ${C.startAlt})`)],
      up: false,
    }
  }
  if (!body || body.status !== 'ok') {
    return { results: [result(WARN, `server: ${url} did not answer like the office server — something else on :${port}?`)], up: false }
  }
  const out = []
  const version = body.version ? `v${body.version}` : '(version unknown — older server)'
  const up = typeof body.uptimeMs === 'number' ? `, up ${formatSpan(body.uptimeMs)}` : ''
  out.push(result(PASS, `server: ${version}${up} on :${port} — ${body.sessions ?? '?'} session(s), ${body.agents ?? 0} agent(s), ${body.clients ?? 0} office window(s) connected`,
    body.clients === 0 ? `no office window is connected: ${C.open} opens it with the office token` : null))
  if (typeof body.hooksSeen !== 'number') {
    out.push(result(WARN, 'server: this server predates hook counting — restart it from this checkout'))
  } else if (body.hooksSeen > 0) {
    out.push(result(PASS, `hooks reaching the server: ${body.hooksSeen} since it started, last ${formatSpan(now - body.lastHookAt)} ago`))
  } else {
    out.push(result(WARN, `hooks reaching the server: none since it started${up ? ` (${formatSpan(body.uptimeMs)} ago)` : ''}`,
      'run a tool in Antigravity and re-check; if nothing arrives, see the hooks line above'))
  }
  if (body.uiAvailable === false) {
    out.push(result(WARN, `server: UI not built — http://127.0.0.1:${port}/ is a 404; ${C.start} serves it there${C.dev ? `, or ${C.dev} for Vite on :3333` : ''}`))
  }
  return { results: out, up: true, body }
}

export function checkToken({ officeHome, serverUp }) {
  const file = join(officeHome, 'auth-token')
  if (!existsSync(file)) {
    return serverUp
      ? result(FAIL, `token: ${file} is missing although the server is up — hooks cannot authenticate`, 'is the server running with another AGENT_OFFICE_HOME? set the same one for the hook, or restart it from here')
      : result(WARN, `token: ${file} not written yet — the server writes it when it starts`)
  }
  if (process.platform === 'win32') return result(PASS, `token: ${file}`)
  let mode
  try {
    mode = statSync(file).mode & 0o777
  } catch (err) {
    return result(FAIL, `token: ${file} cannot be read (${err instanceof Error ? err.message : err})`)
  }
  if (mode & 0o077) {
    return result(FAIL, `token: ${file} is mode 0${mode.toString(8)} — anyone on this machine can post as an agent`, `chmod 600 "${file}" (the server also rewrites it 0600 when it starts)`)
  }
  return result(PASS, `token: ${file} (0600)`)
}

export function checkDist({ root, port = DEFAULT_PORT, commands: C = COMMANDS }) {
  const index = join(root, 'dist', 'index.html')
  if (existsSync(index)) return result(PASS, `dist/: built — the server serves it at http://127.0.0.1:${port}/`)
  return result(WARN, `dist/: not built — ${C.distMissing}`)
}

export function checkHookFiles({ root, hooksDir = join(root, 'hooks'), commands: C = COMMANDS }) {
  const relay = join(hooksDir, RELAY_NAME)
  if (!existsSync(relay)) {
    return result(FAIL, `hook files: ${relay} is missing — Antigravity hooks cannot deliver events`, C.restoreHooks)
  }
  return result(PASS, `hook files: ${RELAY_NAME} present`)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runDoctor(opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? homedir()
  const officeHome = opts.officeHome ?? env.AGENT_OFFICE_HOME ?? join(home, '.agent-office')
  const port = Number(opts.port ?? env.AGENT_OFFICE_PORT) || DEFAULT_PORT
  const root = opts.root ?? ROOT
  const hooksDir = opts.hooksDir ?? join(root, 'hooks')
  const commands = opts.commands ?? COMMANDS
  const relay = join(hooksDir, RELAY_NAME)
  const hooksPath = opts.hooksPath ?? targetFile('antigravity', home)
  const events = expectedEvents(root)

  const configState = readJson(hooksPath)
  const config = configState.value ?? {}

  const results = []
  results.push(checkNode(opts.nodeVersion))
  const hooks = checkHooks({ hooksPath, config, configState, events, relay, home, commands })
  results.push(...hooks.results)
  results.push(checkAgy(opts.path ?? env.PATH))
  const server = await checkServer({ port, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, commands })
  results.push(...server.results)
  results.push(checkToken({ officeHome, serverUp: server.up }))
  results.push(checkDist({ root, port, commands }))
  results.push(checkHookFiles({ root, hooksDir: existsSync(hooksDir) ? hooksDir : join(root, 'hooks'), commands }))

  return {
    results,
    ok: !results.some(r => r.level === FAIL),
    context: { home, hooksPath, officeHome, port, root, relay, events, commands },
  }
}

const ANSI = { [PASS]: '\x1b[32m', [WARN]: '\x1b[33m', [FAIL]: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }

export function formatReport({ results, ok, context }, { color = false } = {}) {
  const C = context.commands ?? COMMANDS
  const c = (code, text) => (color ? `${ANSI[code]}${text}${ANSI.reset}` : text)
  const lines = [c('bold', 'Antigravity Office doctor'), c('dim', `  ${context.root}  ·  hooks ${context.hooksPath}  ·  port ${context.port}`), '']
  for (const r of results) {
    lines.push(`  ${c(r.level, r.level)}  ${r.title}`)
    for (const note of r.notes) lines.push(`        ${c('dim', note)}`)
  }
  const counts = { [PASS]: 0, [WARN]: 0, [FAIL]: 0 }
  for (const r of results) counts[r.level]++
  lines.push('')
  lines.push(`  ${counts[PASS]} passed, ${counts[WARN]} warning(s), ${counts[FAIL]} failed${ok ? '' : c(FAIL, ' — fix the FAIL lines above')}`)
  lines.push('')
  lines.push(c('bold', 'Commands') + c('dim', C === COMMANDS ? `  (from ${context.root})` : ''))
  const rows = [
    ['install / repair Antigravity hooks', C.install],
    ['uninstall hooks', C.uninstall],
    ['start the office', `${C.start}    # or: ${C.startAlt}`],
    ['optional chat AI replies', C.chatWatcher],
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  for (const [k, v] of rows) lines.push(`  ${k.padEnd(width)}  ${v}`)
  lines.push(c('dim', '  honours AGENT_OFFICE_PORT, AGENT_OFFICE_HOME; --json for machine-readable output'))
  return lines
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  const args = new Set(process.argv.slice(2))
  if (args.has('-h') || args.has('--help')) {
    console.log('Usage: npm run doctor [-- --json] [--no-color]\n  Checks node, Antigravity hooks, agy CLI, the server, the auth token and the build; exit 1 on any FAIL.')
    process.exit(0)
  }
  const report = await runDoctor()
  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const color = !!process.stdout.isTTY && !process.env.NO_COLOR && !args.has('--no-color')
    console.log(formatReport(report, { color }).join('\n'))
  }
  process.exit(report.ok ? 0 : 1)
}
