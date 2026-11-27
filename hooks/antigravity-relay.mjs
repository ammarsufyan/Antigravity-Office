#!/usr/bin/env node
/**
 * antigravity-relay.mjs - Cross-platform Node.js lifecycle hook relay for Antigravity.
 *
 * Reads an Antigravity hook payload (protojson camelCase) from stdin and POSTs it
 * unchanged to http://127.0.0.1:<AGENT_OFFICE_PORT|3334>/hook/antigravity, signed
 * with HMAC-SHA256 using $AGENT_OFFICE_HOME/auth-token.
 *
 * Security & resilience:
 *   - Loopback only (ignores AGENT_OFFICE_EVENT_URL).
 *   - Skips forwarding when AGENT_OFFICE_RUN=1 (prevents chat watcher loops).
 *   - Always outputs valid JSON ({}) and exits 0 within TIMEOUT_MS so Antigravity is never blocked.
 *   - On Stop, if a prompt-queue marker exists for this conversation, claims the queued
 *     chat prompt, verifies its HMAC proof, and returns {"decision":"continue","reason":...}.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 1500
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/
const SAFE_EVENT = /^[A-Za-z0-9._]{1,60}$/

function officeHome() {
  return process.env.AGENT_OFFICE_HOME || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.agent-office')
}

function readToken(home) {
  try {
    return readFileSync(join(home, 'auth-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function readPort() {
  const raw = process.env.AGENT_OFFICE_PORT || ''
  if (!/^\d+$/.test(raw)) return 3334
  const n = Number(raw)
  return n > 0 && n < 65536 ? n : 3334
}

function sign(token, path, ts, body) {
  const h = createHmac('sha256', token)
  h.update(`POST\n${path}\n${ts}\n`)
  h.update(body)
  return h.digest('hex')
}

function proofValid(token, nonce, prompt) {
  if (!prompt || typeof prompt.id !== 'string' || typeof prompt.text !== 'string' || typeof prompt.proof !== 'string') return false
  if (!/^[0-9a-f]+$/.test(prompt.proof)) return false
  const given = Buffer.from(prompt.proof, 'hex')
  const expected = createHmac('sha256', token).update(`office-prompt\n${nonce}\n${prompt.id}\n${prompt.text}`).digest()
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function postJson(port, path, body, token) {
  return new Promise(resolve => {
    const ts = String(Date.now())
    const sig = sign(token, path, ts, body)
    let done = false
    const finish = text => {
      if (done) return
      done = true
      resolve(text)
    }
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'X-Office-Timestamp': ts,
        'X-Office-Signature': sig,
      },
      timeout: TIMEOUT_MS,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('timeout', () => { req.destroy(); finish('') })
    req.on('error', () => finish(''))
    req.end(body)
  })
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function main() {
  const raw = await readStdin()
  let payload
  try {
    payload = JSON.parse(raw.toString('utf8') || 'null')
  } catch {
    process.stdout.write('{}')
    return
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    process.stdout.write('{}')
    return
  }

  const argEvent = process.argv[2] || ''
  const rawEvent = (typeof payload.hookEventName === 'string' && payload.hookEventName) || argEvent
  const event = SAFE_EVENT.test(rawEvent) ? rawEvent : ''

  const captureDir = process.env.AGENT_OFFICE_CAPTURE_DIR
  if (captureDir) {
    try {
      writeFileSync(join(captureDir, `antigravity-${event || 'event'}-${Date.now()}.json`), raw)
    } catch {}
  }

  const home = officeHome()
  const sid = typeof payload.conversationId === 'string' ? payload.conversationId : ''
  const wantsClaim = event === 'Stop' && SAFE_ID.test(sid) && existsSync(join(home, 'prompt-queue', `antigravity_${sid}`))

  // Antigravity treats `{}` on PreToolUse as deny; return `ask` as defense-in-depth if someone registers PreToolUse manually
  const defaultReply = event === 'PreToolUse' ? '{"decision":"ask"}' : '{}'
  if (!wantsClaim) process.stdout.write(defaultReply)

  if (process.env.AGENT_OFFICE_RUN === '1') {
    if (wantsClaim) process.stdout.write(defaultReply)
    return
  }

  const token = readToken(home)
  if (!token) {
    if (wantsClaim) process.stdout.write(defaultReply)
    return
  }

  const nonce = wantsClaim ? randomBytes(16).toString('hex') : ''
  const params = []
  if (event) params.push(`event=${encodeURIComponent(event)}`)
  if (wantsClaim) params.push(`claim=1&nonce=${nonce}`)
  const path = `/hook/antigravity${params.length ? `?${params.join('&')}` : ''}`

  const reply = await postJson(readPort(), path, raw, token)
  if (!wantsClaim) return

  let out = '{}'
  try {
    const parsed = JSON.parse(reply || '{}')
    if (proofValid(token, nonce, parsed.prompt)) {
      out = JSON.stringify({
        decision: 'continue',
        reason: `[Message from Antigravity Office chat]\n\n${parsed.prompt.text}`,
      })
    }
  } catch {}
  process.stdout.write(out)
}

main().catch(() => {
  try { process.stdout.write('{}') } catch {}
}).finally(() => {
  process.exit(0)
})
