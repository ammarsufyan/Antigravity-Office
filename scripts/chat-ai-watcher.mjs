#!/usr/bin/env node
/**
 * chat-ai-watcher.mjs - Cross-platform Node.js office chat AI watcher powered by `agy -p`.
 *
 * Polls the local Antigravity Office server for messages typed by a person,
 * routes them to the matching specialist persona using locales/*.json, and
 * generates a short in-character reply with `agy -p` (with AGENT_OFFICE_RUN=1
 * so Antigravity hooks ignore the bot's own runs).
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOCALES = resolve(SCRIPT_DIR, '..', 'locales')
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/

const ROUTES = [
  ['debugger', 'debugger', 'Debugger'],
  ['codeReviewer', 'code-reviewer', 'Reviewer'],
  ['frontend', 'frontend-developer', 'Frontend'],
  ['tester', 'test-engineer', 'Tester'],
  ['security', 'security-auditor', 'Security'],
  ['devops', 'devops-engineer', 'DevOps'],
  ['performance', 'performance-engineer', 'PerfEng'],
  ['database', 'database-architect', 'DBA'],
  ['typescript', 'typescript-pro', 'TS Pro'],
  ['ai', 'ai-engineer', 'AI Eng'],
  ['fullstack', 'fullstack-developer', 'Fullstack'],
  ['git', 'code-reviewer', 'Reviewer'],
  ['architect', 'architect-reviewer', 'Architect'],
]

function loadRouting(localesDir, code) {
  try {
    const data = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'))
    const r = data?.server?.routing
    return r && typeof r === 'object' ? r : {}
  } catch {
    return {}
  }
}

/** Route a chat message to { role, name } using en.json + optional office language keywords. */
export function routeMessage(text, lang = '', localesDir = DEFAULT_LOCALES) {
  const msg = String(text ?? '').toLowerCase()
  const en = loadRouting(localesDir, 'en')
  const own = lang && lang !== 'en' && /^[a-z0-9-]+$/i.test(lang) ? loadRouting(localesDir, lang) : {}
  const loose = Object.keys(own).length === 0 && !(lang && lang !== 'en')
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hit = word => {
    const w = word.trim().toLowerCase()
    if (!w) return false
    if (loose || CJK_RE.test(w)) return msg.includes(w)
    const re = new RegExp(`(?<![^\\W_])${esc(w)}${w.length <= 3 ? '(?![^\\W_])' : ''}`)
    return re.test(msg)
  }
  for (const [key, role, name] of ROUTES) {
    const words = [...(Array.isArray(en[key]) ? en[key] : []), ...(Array.isArray(own[key]) ? own[key] : [])].filter(w => typeof w === 'string')
    if (words.some(hit)) return { role, name }
  }
  return { role: 'assistant', name: 'Antigravity' }
}

/** Clamp a reply to 15 words (or 40 chars for CJK text without spaces). */
export function clampReply(raw) {
  let text = String(raw ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 15).join(' ')
  if (CJK_RE.test(text)) text = [...text].slice(0, 40).join('')
  return text
}

const DEFAULT_MODEL = 'gemini-4-hydrogen-low'

/** CLI args for a non-interactive one-shot `agy -p` call. */
export function buildAgyArgs(prompt, { model = DEFAULT_MODEL, timeoutSec = 60 } = {}) {
  const m = model && model !== 'default' ? model : ''
  return [
    '-p', prompt,
    ...(m ? ['--model', m] : []),
    '--disable-slash-commands',
    '--print-timeout', `${timeoutSec}s`,
  ]
}

function isHumanMessage(m) {
  return m
    && (m.role ?? 'default') === 'default'
    && !m.is_system
    && !m.recipient
    && typeof m.text === 'string'
    && m.text.trim() !== ''
    && !m.text.trimStart().startsWith('/')
}

function gitBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function runCli(cli, args, timeoutMs, onChild) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = res => { if (!settled) { settled = true; resolve(res) } }
    let child
    try {
      child = spawn(cli, args, {
        env: { ...process.env, AGENT_OFFICE_RUN: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      done({ code: 1, stdout: '', stderr: err.message })
      return
    }
    onChild?.(child)
    child.stdout?.on('data', d => { stdout += d })
    child.stderr?.on('data', d => { stderr += d })
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.on('error', err => { clearTimeout(timer); done({ code: 1, stdout, stderr: err.message }) })
    child.on('close', code => { clearTimeout(timer); onChild?.(null); done({ code, stdout, stderr }) })
  })
}

export async function startWatcher(env = process.env) {
  const port = Number(env.AGENT_OFFICE_PORT) || 3334
  const server = `http://127.0.0.1:${port}`
  const pollMs = Math.max(100, Math.round((Number(env.CHAT_AI_POLL_INTERVAL) || 8) * 1000))
  const model = (env.CHAT_AI_MODEL || DEFAULT_MODEL).trim()
  const timeoutSec = Math.max(5, Number(env.CHAT_AI_TIMEOUT) || 60)
  const maxPerMin = Math.max(1, Number(env.CHAT_AI_MAX_REPLIES_PER_MIN) || 5)
  const cli = env.CHAT_AI_CLI || 'agy'
  const localesDir = env.AGENT_OFFICE_LOCALES_DIR || DEFAULT_LOCALES
  const stateDir = env.AGENT_OFFICE_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.agent-office')

  const pidFile = join(stateDir, 'chat-watcher.pid')
  const lastTsFile = join(stateDir, 'chat-ai-last-ts')
  const tokenFile = join(stateDir, 'auth-token')

  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(pidFile, `${process.pid}\n`)

  const saveTs = ts => {
    const tmp = `${lastTsFile}.tmp`
    writeFileSync(tmp, `${ts}\n`)
    renameSync(tmp, lastTsFile)
  }

  const now = Date.now()
  let lastTs = 0
  try {
    const raw = readFileSync(lastTsFile, 'utf8').trim()
    if (/^\d{1,15}$/.test(raw) && Number(raw) <= now) lastTs = Number(raw)
  } catch {}
  if (!lastTs) {
    lastTs = now
    saveTs(lastTs)
  }

  console.log(`[chat-ai] Started (pid ${process.pid}), polling ${server} every ${pollMs / 1000}s, cli=${cli}, model=${model || 'default'}`)

  const callTimes = []
  let busy = false
  let activeChild = null
  let stopped = false

  const cleanup = () => {
    if (stopped) return
    stopped = true
    if (activeChild) { try { activeChild.kill() } catch {} }
    try { unlinkSync(pidFile) } catch {}
    console.log('[chat-ai] Stopped')
    process.exit(0)
  }
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)

  const rateLimited = () => {
    const cutoff = Date.now() - 60_000
    while (callTimes.length && callTimes[0] < cutoff) callTimes.shift()
    return callTimes.length >= maxPerMin
  }

  async function fetchJson(path) {
    const res = await fetch(`${server}${path}`, { signal: AbortSignal.timeout(4000) })
    return res.ok ? res.json() : null
  }

  async function replyTo(msg) {
    const settings = await fetchJson('/settings').catch(() => null)
    const langCode = typeof settings?.language === 'string' && settings.language !== 'en' ? settings.language : ''
    const langName = langCode ? (settings?.languages ?? []).find(l => l?.code === langCode)?.englishName || '' : ''
    const { role, name } = routeMessage(msg, langCode, localesDir)

    let persona = ''
    for (const f of ['antigravity-persona.md', 'claude-persona.md']) {
      const p = join(stateDir, f)
      if (existsSync(p)) { persona = readFileSync(p, 'utf8'); break }
    }

    const chatData = await fetchJson('/chat').catch(() => null)
    const context = (chatData?.messages ?? []).slice(-10).map(m => `${m.sender ?? '?'}: ${m.text ?? ''}`).join('\n')
    const branch = gitBranch()
    const prompt = [
      persona,
      `You are responding as ${name}, the office ${role}. Stay in character.`,
      branch ? `Git branch: ${branch}` : '',
      `Recent conversation:\n${context}`,
      `Reply to the latest message naturally. Keep it short (8-12 words). Continue the conversation — reference previous messages if relevant.${langName ? `\nReply in ${langName}.` : ''}`,
    ].filter(Boolean).join('\n\n')

    callTimes.push(Date.now())
    const res = await runCli(cli, buildAgyArgs(prompt, { model, timeoutSec }), (timeoutSec + 5) * 1000, c => { activeChild = c })
    const reply = clampReply(res.stdout)
    if (!reply) {
      console.log(`[chat-ai] Empty reply from ${cli}${res.stderr ? `: ${res.stderr.trim()}` : ''}`)
      return
    }

    const headers = { 'Content-Type': 'application/json' }
    try { headers.Authorization = `Bearer ${readFileSync(tokenFile, 'utf8').trim()}` } catch {}
    const posted = await fetch(`${server}/chat/reply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sender: name, role, text: reply }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    if (posted?.ok) console.log(`[chat-ai] Replied as ${name}: ${reply}`)
    else console.log(`[chat-ai] Failed to post reply (HTTP ${posted?.status ?? 'network error'})`)
  }

  async function tick() {
    if (stopped || busy) return
    const health = await fetchJson('/health').catch(() => null)
    if (!health) return
    const cron = await fetchJson('/chat/cron-state').catch(() => null)
    if (cron?.paused !== false) return
    const data = await fetchJson(`/chat?since=${lastTs}`).catch(() => null)
    const msgs = Array.isArray(data?.messages) ? data.messages : []
    const newest = msgs.reduce((max, m) => Math.max(max, Number(m?.timestamp) || 0), 0)
    if (newest > lastTs) {
      lastTs = newest
      saveTs(lastTs)
    }
    const human = msgs.filter(isHumanMessage)
    if (!human.length) return
    if (rateLimited()) {
      console.log(`[chat-ai] Reply cap reached (${maxPerMin} per minute)`)
      return
    }
    busy = true
    try {
      await replyTo(human[human.length - 1].text.replace(/[\r\n]+/g, ' '))
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, pollMs)
  return { stop: () => { clearInterval(timer); cleanup() } }
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) startWatcher()
