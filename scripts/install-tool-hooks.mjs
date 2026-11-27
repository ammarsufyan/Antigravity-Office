#!/usr/bin/env node
/**
 * install-tool-hooks.mjs - connect Google Antigravity to Antigravity Office
 * by editing ~/.gemini/config/hooks.json.
 *
 *   node scripts/install-tool-hooks.mjs              connect
 *   node scripts/install-tool-hooks.mjs --uninstall  disconnect
 *
 * Registers 5 passive observation events (SessionStart, PreInvocation,
 * PostInvocation, PostToolUse, Stop) pointing at hooks/antigravity-relay.mjs.
 * PreToolUse is intentionally omitted because Antigravity treats an empty {}
 * response on PreToolUse as deny.
 *
 * Safety rules (tests/install-tool-hooks.test.ts):
 *   - only our own entry ("antigravity-office", plus legacy "claude-office") is
 *     ever added or removed;
 *   - before the first change to an existing file its original bytes are kept
 *     in <file>.antigravity-office.bak, and an uninstall that leaves the file
 *     as it was restores those exact bytes (a file we created is removed);
 *   - a symlinked config file is refused, never written through;
 *   - installing twice changes nothing.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const TOOL_IDS = Object.freeze(['antigravity'])
const LABELS = { antigravity: 'Antigravity' }
const AGY_RELAY = 'antigravity-relay.mjs'
const AGY_NAME = 'antigravity-office'
const AGY_LEGACY_NAME = 'claude-office'
const BACKUP_SUFFIX = '.antigravity-office.bak'
const LEGACY_BACKUP_SUFFIX = '.claude-office.bak'
const REPO_HOOKS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks')

// Why no PreToolUse: Antigravity requires an explicit allow/deny/ask decision on PreToolUse ({} denies every tool)
const EVENTS = {
  antigravity: {
    SessionStart: 'flat',
    PreInvocation: 'flat',
    PostInvocation: 'flat',
    PostToolUse: 'grouped',
    Stop: 'flat',
  },
}
// Why 2 s: the relay gives up after 1.5 s; Antigravity's own timeout is a backstop
const TIMEOUT_S = 2

// ── Where Antigravity keeps its config ──────────────────────────────────────

function toolPresent(tool, home) {
  if (tool !== 'antigravity') return false
  return existsSync(join(home, '.gemini', 'antigravity'))
    || existsSync(join(home, '.gemini', 'antigravity-cli'))
    || existsSync(join(home, '.gemini', 'config'))
}

/**
 * The config file install edits for Antigravity.
 * @param {string} tool  'antigravity'
 * @param {string} home  the home directory
 * @returns {string} absolute path
 */
export function targetFile(tool, home) {
  if (tool !== 'antigravity') throw new Error(`Unknown tool: ${tool}`)
  return join(home, '.gemini', 'config', 'hooks.json')
}

// ── File helpers ────────────────────────────────────────────────────────────

function assertNotSymlink(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; refusing to write through it. Add the hooks by hand, or replace the link with a file.`)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** Write via a temp file and rename, preserving permissions on POSIX. */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : null
  const tmp = `${file}.antigravity-office.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  if (mode !== null && process.platform !== 'win32') chmodSync(tmp, mode)
  renameSync(tmp, file)
}

/** Keep the original bytes once, before our first change to an existing file. */
function backupOnce(file, original) {
  if (original === null || existsSync(file + BACKUP_SUFFIX) || existsSync(file + LEGACY_BACKUP_SUFFIX)) return
  writeFileSync(file + BACKUP_SUFFIX, original, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(file + BACKUP_SUFFIX, 0o600)
}

function relayCommand(hooksDir, event) {
  // Normalize Windows backslashes to forward slashes so JSON shell commands stay valid cross-platform
  const relay = join(hooksDir, AGY_RELAY).replace(/\\/g, '/')
  if (/["$`\n]/.test(relay)) throw new Error(`The hooks folder path ${hooksDir} has a character a hook command cannot carry (" $ \` or a newline)`)
  return `node "${relay}"${event ? ` ${event}` : ''}`
}

// ── JSON config editing ─────────────────────────────────────────────────────

/** The config without any entry of ours. */
function stripJson(cfg) {
  const out = structuredClone(cfg)
  delete out[AGY_NAME]
  delete out[AGY_LEGACY_NAME]
  return out
}

function addJson(cfg, hooksDir) {
  const out = structuredClone(cfg)
  const entry = {}
  for (const [event, shape] of Object.entries(EVENTS.antigravity)) {
    const handler = { type: 'command', command: relayCommand(hooksDir, event), timeout: TIMEOUT_S }
    entry[event] = shape === 'grouped' ? [{ matcher: '', hooks: [handler] }] : [handler]
  }
  out[AGY_NAME] = entry
  return out
}

function parseJson(text, file) {
  if (text === null || !text.trim()) return {}
  const cfg = JSON.parse(text)
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file} is not a JSON object; not touching it`)
  return cfg
}

function installJson(file, hooksDir) {
  const original = readText(file)
  const cfg = parseJson(original, file)
  const next = JSON.stringify(addJson(stripJson(cfg), hooksDir), null, 2) + '\n'
  if (next === original) return []
  backupOnce(file, original)
  writeAtomic(file, next)
  return [file]
}

function uninstallJson(file) {
  const current = readText(file)
  if (current === null) return []
  const cfg = parseJson(current, file)
  const stripped = stripJson(cfg)
  if (isDeepStrictEqual(stripped, cfg)) return []
  const backup = readText(file + BACKUP_SUFFIX) ?? readText(file + LEGACY_BACKUP_SUFFIX)
  if (backup !== null && isDeepStrictEqual(stripped, parseJson(backup, file))) {
    writeAtomic(file, backup)
  } else if (backup === null && Object.keys(stripped).length === 0) {
    unlinkSync(file)
  } else {
    writeAtomic(file, JSON.stringify(stripped, null, 2) + '\n')
  }
  return [file]
}

// ── Public API ──────────────────────────────────────────────────────────────

function checkTool(tool) {
  if (!TOOL_IDS.includes(tool)) throw new Error(`Unknown tool: ${tool}. Use one of: ${TOOL_IDS.join(', ')}`)
}

/**
 * Connect Antigravity to the office.
 * @param {string} [tool]  'antigravity'
 * @param {{ home?: string, hooksDir: string }} opts  hooksDir holds antigravity-relay.mjs
 * @returns {{ changed: string[], notes: string[] }}
 */
export function install(tool = 'antigravity', { home = homedir(), hooksDir } = {}) {
  checkTool(tool)
  const file = targetFile(tool, home)
  assertNotSymlink(file)
  const changed = installJson(file, hooksDir)
  return { changed, notes: ['Restart any open Antigravity session to pick it up.'] }
}

/**
 * Disconnect Antigravity: remove only what install added.
 * @param {string} [tool]  'antigravity'
 * @param {{ home?: string }} [opts]
 * @returns {{ changed: string[], notes: string[] }}
 */
export function uninstall(tool = 'antigravity', { home = homedir() } = {}) {
  checkTool(tool)
  const file = targetFile(tool, home)
  assertNotSymlink(file)
  const changed = uninstallJson(file)
  return { changed, notes: changed.length ? [] : ['Antigravity was not connected; nothing to remove.'] }
}

/**
 * Is Antigravity connected?
 * @param {string} [tool]  'antigravity'
 * @param {{ home?: string }} [opts]
 * @returns {'connected' | 'not-connected' | 'not-installed'}
 */
export function status(tool = 'antigravity', { home = homedir() } = {}) {
  checkTool(tool)
  if (!toolPresent(tool, home)) return 'not-installed'
  const text = readText(targetFile(tool, home))
  if (text === null) return 'not-connected'
  try {
    const cfg = parseJson(text, '')
    return isDeepStrictEqual(stripJson(cfg), cfg) ? 'not-connected' : 'connected'
  } catch {
    return 'not-connected'
  }
}

/** Display name. */
export function toolLabel(tool) {
  return LABELS[tool] ?? tool
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/**
 * Run from the command line: [--uninstall] [--tool antigravity] [--hooks-dir <dir>].
 * @returns {number} exit code
 */
export function main(argv, { out = process.stdout, err = process.stderr, home = homedir(), hooksDir = REPO_HOOKS } = {}) {
  let tool = 'antigravity'
  let remove = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--uninstall') remove = true
    else if (a === '--tool') tool = argv[++i] ?? ''
    else if (a.startsWith('--tool=')) tool = a.slice('--tool='.length)
    else if (a === '--hooks-dir') hooksDir = argv[++i]
  }
  if (!TOOL_IDS.includes(tool)) {
    err.write(`--tool needs one of: ${TOOL_IDS.join(', ')}\n`)
    return 2
  }
  try {
    if (!remove && !toolPresent(tool, home)) {
      out.write(`${toolLabel(tool)} does not look installed here (no config folder found); connecting anyway.\n`)
    }
    const { changed, notes } = remove ? uninstall(tool, { home }) : install(tool, { home, hooksDir })
    for (const f of changed) out.write(`${remove ? 'Removed the office from' : 'Connected the office in'} ${f}\n`)
    if (!changed.length && !remove) out.write(`${toolLabel(tool)} was already connected.\n`)
    for (const n of notes) out.write(`${n}\n`)
    return 0
  } catch (e) {
    err.write(`${e.message}\n`)
    return 1
  }
}

let isMain = false
try { isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] } catch {}
if (isMain) process.exit(main(process.argv.slice(2)))
