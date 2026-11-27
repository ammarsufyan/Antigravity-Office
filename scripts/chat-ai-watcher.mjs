#!/usr/bin/env node
/**
 * chat-ai-watcher.mjs - Cross-platform Node.js office chat AI watcher powered by `agy`.
 *
 * Keeps a single warm `agy` process running in NDJSON stream-json mode (eliminating
 * per-message cold starts) and polls the local Antigravity Office server every 1.5s
 * for messages typed by a person, routing them to the matching specialist persona
 * using locales/*.json (with AGENT_OFFICE_RUN=1 so Antigravity hooks ignore bot runs).
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOCALES = resolve(SCRIPT_DIR, '..', 'locales')
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const DEFAULT_MODEL = 'gemini-4-hydrogen-low'
// Rotate the persistent agy conversation periodically so context stays fast and small
const MAX_TURNS_PER_SESSION = 25

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

/** CLI args for a one-shot `agy -p` call. */
export function buildAgyArgs(prompt, { model = DEFAULT_MODEL, timeoutSec = 60 } = {}) {
  const m = model && model !== 'default' ? model : ''
  return [
    '-p', prompt,
    ...(m ? ['--model', m] : []),
    '--disable-slash-commands',
    '--print-timeout', `${timeoutSec}s`,
  ]
}

/** CLI args for a persistent NDJSON `agy` stream-json session. */
export function buildAgyStreamArgs({ model = DEFAULT_MODEL } = {}) {
  const m = model && model !== 'default' ? model : ''
  return [
    ...(m ? ['--model', m] : []),
    '--disable-slash-commands',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '-p=',
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

/**
 * Persistent warm `agy` stream-json client.
 * Boots once and reuses the same process for fast (~2-3s) replies; automatically
 * restarts on exit, timeout, or after MAX_TURNS_PER_SESSION turns.
 */
function createAgySession(cli, { model, timeoutMs }) {
  let child = null
  let buf = ''
  let stderr = ''
  let turns = 0
  let pending = null // { resolve, timer }
  let readyPromise = null
  let resolveReady = null

  function dropChild() {
    const old = child
    child = null
    buf = ''
    turns = 0
    readyPromise = null
    resolveReady = null
    if (old) {
      try { old.stdin?.end() } catch {}
      try { old.kill() } catch {}
    }
  }

  function finishPending(res) {
    if (!pending) return
    const p = pending
    pending = null
    clearTimeout(p.timer)
    p.resolve(res)
  }

  function ensureStarted() {
    if (child && !child.killed && child.exitCode === null) return readyPromise
    stderr = ''
    buf = ''
    turns = 0
    readyPromise = new Promise(res => { resolveReady = res })

    try {
      child = spawn(cli, buildAgyStreamArgs({ model }), {
        env: { ...process.env, AGENT_OFFICE_RUN: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      resolveReady?.()
      finishPending({ stdout: '', stderr: err.message })
      return readyPromise
    }

    // Fallback in case init takes unusually long; allow sending after 5s
    const initTimer = setTimeout(() => resolveReady?.(), 5000)
    initTimer.unref?.()

    child.stderr?.on('data', d => { stderr += d })
    child.stdout?.on('data', d => {
      buf += d.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (obj.event === 'init') {
          clearTimeout(initTimer)
          resolveReady?.()
        } else if (obj.event === 'result') {
          turns++
          const text = typeof obj.result?.response === 'string' ? obj.result.response : ''
          const err = typeof obj.result?.error === 'string' ? obj.result.error : ''
          finishPending({ stdout: text, stderr: err || stderr })
          stderr = ''
          if (turns >= MAX_TURNS_PER_SESSION) dropChild()
        }
      }
    })
    child.on('error', err => {
      clearTimeout(initTimer)
      resolveReady?.()
      finishPending({ stdout: '', stderr: err.message })
      dropChild()
    })
    child.on('close', () => {
      clearTimeout(initTimer)
      resolveReady?.()
      finishPending({ stdout: '', stderr })
      child = null
      readyPromise = null
      resolveReady = null
    })

    return readyPromise
  }

  async function ask(prompt) {
    await ensureStarted()
    if (!child || !child.stdin || child.killed || child.exitCode !== null) {
      return { stdout: '', stderr: stderr || 'agy process is not running' }
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        finishPending({ stdout: '', stderr: 'timed out waiting for agy reply' })
        dropChild()
      }, timeoutMs)
      pending = { resolve, timer }
      try {
        child.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n')
      } catch (err) {
        finishPending({ stdout: '', stderr: err.message })
        dropChild()
      }
    })
  }

  return { warm: () => { ensureStarted() }, ask, stop: dropChild }
}

export async function startWatcher(env = process.env) {
  const port = Number(env.AGENT_OFFICE_PORT) || 3334
  const server = `http://127.0.0.1:${port}`
  const pollMs = Math.max(250, Math.round((Number(env.CHAT_AI_POLL_INTERVAL) || 1.5) * 1000))
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

  const agy = createAgySession(cli, { model, timeoutMs: (timeoutSec + 5) * 1000 })
  // Pre-warm agy immediately so the very first chat message avoids cold-start delay
  agy.warm()

  console.log(`[chat-ai] Started (pid ${process.pid}), polling ${server} every ${pollMs / 1000}s, cli=${cli} (warm stream), model=${model || 'default'}`)

  const callTimes = []
  let busy = false
  let stopped = false

  const cleanup = () => {
    if (stopped) return
    stopped = true
    agy.stop()
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
      `You are responding as ${name}, the office ${role}. Stay in character. Do not call any tools.`,
      branch ? `Git branch: ${branch}` : '',
      `Recent conversation:\n${context}`,
      `Reply to the latest message naturally. Keep it short (8-12 words). Continue the conversation — reference previous messages if relevant.${langName ? `\nReply in ${langName}.` : ''}`,
    ].filter(Boolean).join('\n\n')

    callTimes.push(Date.now())
    const startedAt = Date.now()
    const res = await agy.ask(prompt)
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
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (posted?.ok) console.log(`[chat-ai] Replied as ${name} (${elapsed}s): ${reply}`)
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
