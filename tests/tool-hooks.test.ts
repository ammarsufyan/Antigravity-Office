/** POST /hook/:tool — Antigravity's raw hook payload, translated server-side into office sessions tagged with `client`. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadOffice, postAuthed, postEvent, removeOffice, type Office } from './helpers'

const FIXTURES = fileURLToPath(new URL('./fixtures/tools/', import.meta.url))
const fixture = (tool: string, name: string) => JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'))
const withConv = (payload: any, cid: string) => ({ ...payload, conversationId: cid })

describe('POST /hook/:tool', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('turns an Antigravity SessionStart into a session tagged antigravity', async () => {
    const res = await postAuthed(office.server, '/hook/antigravity?event=SessionStart', withConv(fixture('antigravity', 'session-start'), 'start-1'))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, count: 1 })
    const list = await request(office.server.app).get('/sessions')
    const s = list.body.sessions.find((x: any) => x.id === 'antigravity:start-1')
    expect(s).toMatchObject({ client: 'antigravity', project: 'demo-app', state: 'active' })
  })

  it('refuses an unsigned request', async () => {
    const res = await request(office.server.app).post('/hook/antigravity?event=SessionStart').send(fixture('antigravity', 'session-start'))
    expect(res.status).toBe(401)
  })

  it('answers 404 for a tool it does not know', async () => {
    const res = await postAuthed(office.server, '/hook/nope', fixture('antigravity', 'session-start'))
    expect(res.status).toBe(404)
  })

  it('answers 204 for a payload it does not understand', async () => {
    const res = await postAuthed(office.server, '/hook/antigravity?event=SessionStart', {})
    expect(res.status).toBe(204)
  })

  it('makes an implicit session, still tagged, when the first event is a tool call', async () => {
    await postAuthed(office.server, '/hook/antigravity?event=PostToolUse', withConv(fixture('antigravity', 'post-tool'), 'implicit-1'))
    const s = office.server.sessions.get('antigravity:implicit-1')
    expect(s).toBeTruthy()
    expect(s.client).toBe('antigravity')
  })

  it('takes a post-tool payload far over /event\'s 64 KB (full command output)', async () => {
    const big = withConv(fixture('antigravity', 'post-tool'), 'big-1')
    big.tool_response = { output: 'x'.repeat(200 * 1024), exit_code: 0 }
    const res = await postAuthed(office.server, '/hook/antigravity?event=PostToolUse', big)
    expect(res.status).toBe(200)
  })

  it('keeps an Antigravity session and a direct /event session with the same native id apart', async () => {
    await postAuthed(office.server, '/hook/antigravity?event=SessionStart', withConv(fixture('antigravity', 'session-start'), 'same-id'))
    await postEvent(office.server, { type: 'session_started', sessionId: 'same-id', project: 'p', cwd: '/tmp/p', source: 'startup' })
    expect(office.server.sessions.get('antigravity:same-id')?.client).toBe('antigravity')
    expect(office.server.sessions.get('same-id')).toBeTruthy()
  })

  it('leaves a direct /event session without a client', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: 'direct-1', project: 'p', cwd: '/tmp/p', source: 'startup' })
    const list = await request(office.server.app).get('/sessions')
    const s = list.body.sessions.find((x: any) => x.id === 'direct-1')
    expect(s).toBeTruthy()
    expect('client' in s).toBe(false)
  })

  it('ignores a client on /event that is not a known tool', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: 'direct-2', project: 'p', cwd: '/tmp/p', source: 'startup', client: '<script>' })
    expect(office.server.sessions.get('direct-2')?.client).toBeUndefined()
  })
})
