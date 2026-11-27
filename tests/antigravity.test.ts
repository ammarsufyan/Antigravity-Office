/**
 * antigravity.test.ts - End-to-end verification of native Antigravity Office support:
 *   - hooks/antigravity-relay.mjs (signed loopback forwarding, prompt-queue claim + HMAC, timeouts, AGENT_OFFICE_RUN)
 *   - server/tools/antigravity.js (prompts, signals, MCP, subagents, update_steps -> whiteboard, fullyIdle)
 *   - server/transcript.js & server/meterEstimate.js (Antigravity PLANNER_RESPONSE JSONL + Gemini 1M window)
 *   - scripts/chat-ai-watcher.mjs (routing, CJK/word clamping, agy -p flags)
 *   - native plugin manifest (plugin.json + hooks.json)
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, removeOffice, type Office } from './helpers'
import { scanTranscript } from '../server/transcript.js'
import { estimateMemory, lastUsage } from '../server/meterEstimate.js'
import { buildAgyArgs, buildAgyStreamArgs, clampReply, routeMessage } from '../scripts/chat-ai-watcher.mjs'
import { parseWindowsCommandExe } from '../scripts/open-office.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RELAY = join(ROOT, 'hooks', 'antigravity-relay.mjs')

function runRelay(args: string[], payload: unknown, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; ms: number }>(resolve => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [RELAY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d })
    child.on('close', code => resolve({ code, stdout, ms: Date.now() - t0 }))
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
}

async function deadPort(): Promise<number> {
  const s = createServer()
  const p = await listen(s)
  await new Promise(r => s.close(r))
  return p
}

describe('Antigravity native plugin manifests', () => {
  it('ships valid plugin.json and hooks.json without blocking PreToolUse', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'))
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks.json'), 'utf8'))
    expect(plugin.name).toBe('antigravity-office')
    const spec = hooks['antigravity-office']
    expect(Object.keys(spec).sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreInvocation', 'SessionStart', 'Stop'])
    expect(spec.PostToolUse[0].matcher).toBe('')
    expect(spec.PostToolUse[0].hooks[0].command).toContain('antigravity-relay.mjs')
    expect(existsSync(RELAY)).toBe(true)
  })

  it('extracts the Windows default browser executable from registry command strings', () => {
    expect(parseWindowsCommandExe('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1')).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(parseWindowsCommandExe('C:\\Browser\\app.exe %1')).toBe('C:\\Browser\\app.exe')
    expect(parseWindowsCommandExe('')).toBeNull()
  })
})

describe('Antigravity transcript and memory meter', () => {
  const lines = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-26T22:53:00Z', content: 'Run tests' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-26T22:53:05Z',
      model: 'gemini-4-neon-high',
      input_tokens: 20_000,
      cache_read_tokens: 30_000,
      output_tokens: 500,
      thinking: 'private reasoning must not appear',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-26T22:53:10Z',
      model: 'gemini-4-neon-high',
      input_tokens: 25_000,
      cache_read_tokens: 35_000,
      output_tokens: 600,
      content: 'All tests passed.',
    }),
  ].join('\n') + '\n'

  it('parses PLANNER_RESPONSE tool calls (unwrapping quoted args), replies, and usage without leaking thinking', () => {
    const { entries, usage } = scanTranscript(lines)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'tool', tool: 'run_command', input: 'npm test' })
    expect(entries[1]).toMatchObject({ kind: 'said', text: 'All tests passed.' })
    expect(JSON.stringify(entries)).not.toContain('private reasoning')
    expect(usage).toEqual({ tokens: 60_600, model: 'gemini-4-neon-high' })
  })

  it('estimates MEMORY from PLANNER_RESPONSE against the 1M Gemini context window', () => {
    const reading = lastUsage(lines)
    expect(reading).toEqual({ tokens: 60_600, input: 60_000, output: 600, model: 'gemini-4-neon-high' })
    expect(estimateMemory(reading)).toEqual({
      context: { used: 6.1, size: 1_000_000, input: 60_000, output: 600 },
      model: 'Gemini 4 Neon',
      modelId: 'gemini-4-neon-high',
      estimate: { tokens: 60_600, basis: 'model', approximate: false },
    })
  })
})

describe('Antigravity end-to-end: relay -> server -> whiteboard, signals, subagents & prompt queue', () => {
  let office: Office
  let port: number
  let env: Record<string, string>
  const convId = 'agy-e2e-001'
  const sid = `antigravity:${convId}`
  let transcriptFile: string

  beforeAll(async () => {
    office = await loadOffice()
    port = await listen(office.server.httpServer)
    writeFileSync(join(office.dir, 'auth-token'), office.server.AUTH_TOKEN)
    transcriptFile = join(office.dir, 'transcript.jsonl')
    writeFileSync(transcriptFile, JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T22:53:05Z',
      model: 'gemini-4-neon-high', input_tokens: 40_000, cache_read_tokens: 10_000, output_tokens: 500,
      content: 'Checked the repo.',
    }) + '\n')
    env = { AGENT_OFFICE_HOME: office.dir, AGENT_OFFICE_PORT: String(port) }
  })

  afterAll(async () => {
    if (!office) return
    await new Promise<void>(r => office.server.httpServer.close(() => r()))
    removeOffice(office)
  })

  const base = (hookEventName: string, extra: Record<string, unknown> = {}) => ({
    conversationId: convId,
    cwd: '/work/antigravity-app',
    workspacePaths: ['/work/antigravity-app'],
    transcriptPath: transcriptFile,
    modelName: 'gemini-4-neon-high',
    hookEventName,
    ...extra,
  })

  it('drives session start, prompt shout, whiteboard steps, signals, subagent lifecycle, inspector, and @mention prompt claim', async () => {
    // 1. SessionStart
    expect((await runRelay([], base('SessionStart'), env)).stdout).toBe('{}')
    expect(office.server.sessions.get(sid)).toMatchObject({ client: 'antigravity', project: 'antigravity-app', model: 'gemini-4-neon-high' })

    // 2. PreInvocation with lastUserInput shouts the prompt once, then thinking on repeat
    await runRelay([], base('PreInvocation', { lastUserInput: 'Deploy the release' }), env)
    expect(office.server.sessions.get(sid)?.main?.lastPrompt).toBe('Deploy the release')
    await runRelay([], base('PreInvocation', { lastUserInput: 'Deploy the release' }), env)
    expect(office.server.sessions.get(sid)?.lastStatus).toBe('thinking')

    // 3. PostToolUse(update_steps) populates the Kanban whiteboard without PreToolUse
    await runRelay([], base('PostToolUse', {
      stepIdx: 2,
      toolCall: {
        id: 't-steps',
        name: 'update_steps',
        args: {
          steps: [
            { title: 'Run unit tests', status: 'done' },
            { title: 'Deploy build', status: 'in_progress' },
            { title: 'Verify health', status: 'pending' },
          ],
        },
      },
    }), env)
    const tasksRes = await request(office.server.app).get('/tasks')
    const board = tasksRes.body.boards.find((b: any) => b.sessionId === sid)
    expect(board).toMatchObject({ counts: { pending: 1, in_progress: 1, completed: 1 } })

    // 4. PostToolUse(run_command) emits deploy_fail signal on error (and deploy_success when ok)
    await runRelay([], base('PostToolUse', { stepIdx: 3, toolCall: { id: 't-cmd', name: 'run_command', args: { CommandLine: 'vercel --prod' } }, error: 'exit 1' }), env)
    const sigRes = await request(office.server.app).get('/signals')
    expect(sigRes.body.signals.map((s: any) => s.kind)).toContain('deploy_fail')

    // 5. PostToolUse(invoke_subagent) spawns worker; Stop with fullyIdle completes it
    await runRelay([], base('PostToolUse', {
      stepIdx: 4,
      toolCall: { id: 'sub-99', name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Codebase Researcher', Prompt: 'Inspect auth' } },
    }), env)
    expect(office.server.activeAgents.get('antigravity:sub-99')).toMatchObject({ name: 'Codebase Researcher', role: 'Explore', state: 'new-hire' })

    // 6. Inspector card reads Antigravity transcript and names the main character Antigravity
    const card = await request(office.server.app).get(`/agents/main-${sid}`).set('Authorization', `Bearer ${office.server.UI_TOKEN}`)
    expect(card.status).toBe(200)
    expect(card.body).toMatchObject({ name: 'Antigravity', transcriptAvailable: true })
    expect(card.body.transcript[0]).toMatchObject({ kind: 'said', text: 'Checked the repo.' })

    // 7. Queue a chat prompt with @antigravity-app and claim it on Stop
    const queued = await request(office.server.app)
      .post('/chat')
      .set('Authorization', `Bearer ${office.server.UI_TOKEN}`)
      .send({ sender: 'Boss', text: '@antigravity-app check the logs' })
    expect(queued.status).toBe(200)
    expect(existsSync(join(office.dir, 'prompt-queue', `antigravity_${convId}`))).toBe(true)

    const stopOut = await runRelay([], base('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }), env)
    expect(stopOut.code).toBe(0)
    expect(JSON.parse(stopOut.stdout)).toEqual({
      decision: 'continue',
      reason: '[Message from Antigravity Office chat]\n\ncheck the logs',
    })
    expect(office.server.activeAgents.get('antigravity:sub-99')?.state).toBe('completed')
    expect(existsSync(join(office.dir, 'prompt-queue', `antigravity_${convId}`))).toBe(false)

    // Subsequent Stop without queued prompt simply returns {}
    const secondStop = await runRelay([], base('Stop', { fullyIdle: true }), env)
    expect(secondStop.stdout).toBe('{}')
  })

  it('skips forwarding under AGENT_OFFICE_RUN=1 and never blocks on a dead or hung server', async () => {
    const skipped = await runRelay([], { ...base('SessionStart'), conversationId: 'skip-me' }, { ...env, AGENT_OFFICE_RUN: '1' })
    expect(skipped.code).toBe(0)
    expect(skipped.stdout).toBe('{}')
    expect(office.server.sessions.get('antigravity:skip-me')).toBeUndefined()

    const down = await runRelay([], base('PostToolUse'), { ...env, AGENT_OFFICE_PORT: String(await deadPort()) })
    expect(down.code).toBe(0)
    expect(down.stdout).toBe('{}')
    expect((await runRelay([], base('PreToolUse'), { ...env, AGENT_OFFICE_PORT: String(await deadPort()) })).stdout).toBe('{"decision":"ask"}')

    const hung = createTcpServer(() => {})
    const hungPort = await new Promise<number>(res => hung.listen(0, '127.0.0.1', () => res((hung.address() as any).port)))
    try {
      const res = await runRelay([], base('PostToolUse'), { ...env, AGENT_OFFICE_PORT: String(hungPort) })
      expect(res.code).toBe(0)
      expect(res.stdout).toBe('{}')
      expect(res.ms).toBeLessThan(3000)
    } finally {
      hung.close()
    }
  })
})

describe('chat-ai-watcher.mjs (agy -p)', () => {
  it('routes specialist topics and defaults to Antigravity', () => {
    expect(routeMessage('there is a bug in login')).toEqual({ role: 'debugger', name: 'Debugger' })
    expect(routeMessage('please review this PR')).toEqual({ role: 'code-reviewer', name: 'Reviewer' })
    expect(routeMessage('good morning team')).toEqual({ role: 'assistant', name: 'Antigravity' })
  })

  it('clamps replies and builds non-interactive agy -p flags', () => {
    expect(clampReply('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen')).toBe(
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen',
    )
    expect([...clampReply('好'.repeat(60))]).toHaveLength(40)
    expect(buildAgyArgs('hello', { timeoutSec: 30 })).toEqual([
      '-p', 'hello', '--model', 'gemini-4-hydrogen-low', '--disable-slash-commands', '--print-timeout', '30s',
    ])
    expect(buildAgyArgs('hello', { model: 'default', timeoutSec: 30 })).toEqual([
      '-p', 'hello', '--disable-slash-commands', '--print-timeout', '30s',
    ])
    expect(buildAgyStreamArgs()).toEqual([
      '--model', 'gemini-4-hydrogen-low', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json', '-p=',
    ])
  })
})
