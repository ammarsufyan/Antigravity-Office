/** Tool translators — Antigravity hook payloads become office events (server/tools). */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { translateFor, TOOLS } from '../server/tools/index.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/tools/', import.meta.url))
const fixture = (tool: string, name: string) => JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'))
const run = (tool: string, name: string, event?: string) => {
  const payload = fixture(tool, name)
  return translateFor(tool, payload, event ?? payload.hook_event_name) as any[]
}

function expectTagged(tool: string, names: string[], events: (name: string) => any[]) {
  for (const name of names) {
    const out = events(name)
    expect(out.length, `${tool}/${name}`).toBeGreaterThan(0)
    for (const e of out) {
      expect(e.client, name).toBe(tool)
      expect(e.sessionId, name).toMatch(new RegExp(`^${tool}:`))
    }
  }
}

describe('translateFor', () => {
  it('is null for a tool it does not know', () => {
    expect(translateFor('nope', {}, 'SessionStart')).toBeNull()
  })

  it('is empty for a payload it does not understand', () => {
    expect(translateFor('antigravity', 'garbage', 'SessionStart')).toEqual([])
    expect(translateFor('antigravity', {}, 'SessionStart')).toEqual([])
    expect(translateFor('antigravity', fixture('antigravity', 'session-start'), 'NoSuchEvent')).toEqual([])
  })

  it('labels every tool it knows', () => {
    for (const [id, mod] of Object.entries(TOOLS) as [string, any][]) {
      expect(mod.id).toBe(id)
      expect(mod.label).toBeTruthy()
    }
  })
})

describe('antigravity', () => {
  // Antigravity payloads carry no event name: the relay passes it along
  const agy = (name: string, event: string) => run('antigravity', name, event)
  const SID = 'antigravity:agy-conv-1'

  it('starts a session in the first workspace folder', () => {
    expect(agy('session-start', 'SessionStart')[0]).toMatchObject({ type: 'session_started', sessionId: SID, project: 'demo-app', model: 'gemini-3-pro' })
  })

  it('shows tool calls, and a failed one as failed', () => {
    expect(agy('pre-tool', 'PreToolUse')[0]).toMatchObject({ type: 'agent_working', tool: 'run_command' })
    expect(agy('post-tool', 'PostToolUse')).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'session_tool_done', toolName: 'run_command' })]))
    expect(agy('post-tool-error', 'PostToolUse')[0]).toMatchObject({ type: 'agent_working', failed: true })
  })

  it('shows thinking when an invocation starts, and ends the turn on Stop', () => {
    expect(agy('pre-invocation', 'PreInvocation')[0]).toMatchObject({ type: 'agent_working', status: 'thinking' })
    expect(agy('stop', 'Stop')[0]).toMatchObject({ type: 'session_turn_end' })
  })

  it('has nothing to say without an event name', () => {
    expect(translateFor('antigravity', fixture('antigravity', 'stop'), undefined)).toEqual([])
  })

  it('tags every event', () => {
    const pairs: Record<string, string> = { 'session-start': 'SessionStart', 'pre-tool': 'PreToolUse', 'post-tool': 'PostToolUse', 'pre-invocation': 'PreInvocation', stop: 'Stop' }
    expectTagged('antigravity', Object.keys(pairs), n => agy(n, pairs[n]))
  })
})
