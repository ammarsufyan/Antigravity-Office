/**
 * scripts/doctor.mjs — `npm run doctor`: checks Node 22+, Antigravity hooks
 * in ~/.gemini/config/hooks.json, agy CLI, server /health, auth-token, dist/,
 * and hooks/antigravity-relay.mjs. Pure Node.js across Windows/macOS/Linux.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, postEvent, removeOffice, type Office } from './helpers'
import { runDoctor, checkHookFiles, checkNode, scriptPathIn, shellWords, COMMANDS, PASS, WARN, FAIL } from '../scripts/doctor.mjs'
import { install, targetFile } from '../scripts/install-tool-hooks.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCTOR = join(ROOT, 'scripts', 'doctor.mjs')
const RELAY = join(ROOT, 'hooks', 'antigravity-relay.mjs')

type Line = { level: string; title: string; notes: string[] }
type Report = { results: Line[]; ok: boolean; context: Record<string, unknown> }

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function installedHome() {
  const home = tmp('doctor-home-')
  install('antigravity', { home, hooksDir: join(ROOT, 'hooks') })
  return home
}

function writeHooksJson(home: string, data: unknown) {
  const file = targetFile('antigravity', home)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise(resolve => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

const line = (r: Report, prefix: string) => r.results.find(l => l.title.startsWith(prefix))
const lines = (r: Report, prefix: string) => r.results.filter(l => l.title.startsWith(prefix))
const levelOf = (r: Report, prefix: string) => line(r, prefix)?.level

async function base(home: string, over: Record<string, unknown> = {}) {
  return { home, officeHome: join(home, '.agent-office'), port: await freePort(), env: {} as Record<string, string>, ...over }
}

describe('doctor helpers', () => {
  it('splits a hook command and extracts hooks/antigravity-relay.mjs', () => {
    expect(shellWords('node "/a b/hooks/antigravity-relay.mjs" Stop')).toEqual(['node', '/a b/hooks/antigravity-relay.mjs', 'Stop'])
    expect(scriptPathIn('node "C:/GitHub/Antigravity-Office/hooks/antigravity-relay.mjs" Stop')).toBe('C:/GitHub/Antigravity-Office/hooks/antigravity-relay.mjs')
    expect(scriptPathIn('node "/other/antigravity-relay.mjs" Stop')).toBeNull()
    expect(scriptPathIn('echo hi')).toBeNull()
    expect(scriptPathIn(undefined)).toBeNull()
  })

  it('node: 22+ passes, older fails with the floor in the message', () => {
    expect(checkNode('22.22.0').level).toBe(PASS)
    const old = checkNode('20.19.4')
    expect(old.level).toBe(FAIL)
    expect(old.title).toContain('Node 22+')
  })
})

describe('runDoctor', () => {
  it('passes on a HOME with Antigravity hooks installed; server down is WARN, not FAIL', async () => {
    const home = installedHome()
    const r = (await runDoctor(await base(home))) as Report

    expect(line(r, 'node')?.level).toBe(PASS)
    const hooks = line(r, 'hooks:')!
    expect(hooks.level).toBe(PASS)
    expect(hooks.title).toMatch(/^hooks: 5\/5 events run /)
    expect(lines(r, 'hooks:')).toHaveLength(1)
    expect(line(r, 'server:')?.level).toBe(WARN)
    expect(line(r, 'token:')?.level).toBe(WARN)
    expect(['PASS', 'WARN']).toContain(levelOf(r, 'dist/:'))
    expect(line(r, 'hook files:')?.level).toBe(PASS)
    expect(r.ok).toBe(true)
    expect(r.context).toMatchObject({ hooksPath: targetFile('antigravity', home), relay: RELAY })
  })

  it('fails when hooks point at a missing file', async () => {
    const home = tmp('doctor-dead-')
    writeHooksJson(home, {
      'antigravity-office': {
        Stop: [{ type: 'command', command: 'node "/old/moved/path/hooks/antigravity-relay.mjs" Stop' }],
      },
    })
    const r = (await runDoctor(await base(home))) as Report
    const hooks = line(r, 'hooks:')!
    expect(hooks.level).toBe(FAIL)
    expect(hooks.title).toContain('/old/moved/path/hooks/antigravity-relay.mjs')
    expect(hooks.notes.join(' ')).toContain(COMMANDS.install)
    expect(r.ok).toBe(false)
  })

  it('warns about partial install and another checkout path', async () => {
    const home = tmp('doctor-partial-')
    const other = tmp('doctor-other-')
    mkdirSync(join(other, 'hooks'))
    writeFileSync(join(other, 'hooks', 'antigravity-relay.mjs'), '// relay\n')
    const relayPath = join(other, 'hooks', 'antigravity-relay.mjs').replace(/\\/g, '/')
    writeHooksJson(home, {
      'antigravity-office': {
        Stop: [{ type: 'command', command: `node "${relayPath}" Stop` }],
      },
    })
    const r = (await runDoctor(await base(home))) as Report
    const [summary, foreign] = lines(r, 'hooks:')
    expect(summary.level).toBe(WARN)
    expect(summary.title).toMatch(/^hooks: 1\/5 events run /)
    expect(summary.title).toContain('missing:')
    expect(foreign.level).toBe(WARN)
    expect(r.ok).toBe(true)
  })

  it('fails when hooks are not installed or hooks.json is malformed', async () => {
    const home = tmp('doctor-empty-')
    const r = (await runDoctor(await base(home))) as Report
    expect(line(r, 'hooks:')?.level).toBe(FAIL)
    expect(r.ok).toBe(false)

    writeHooksJson(home, '{ not json')
    const r2 = (await runDoctor(await base(home))) as Report
    expect(line(r2, 'hooks config:')?.level).toBe(FAIL)
    expect(r2.ok).toBe(false)
  })

  it('checks hook files and dist/', async () => {
    const root = tmp('doctor-root-')
    mkdirSync(join(root, 'hooks'))
    expect(checkHookFiles({ root }).level).toBe(FAIL)
    writeFileSync(join(root, 'hooks', 'antigravity-relay.mjs'), '// relay\n')
    expect(checkHookFiles({ root }).level).toBe(PASS)

    const home = installedHome()
    const unbuilt = (await runDoctor(await base(home, { root }))) as Report
    expect(line(unbuilt, 'dist/:')?.level).toBe(WARN)
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>')
    const built = (await runDoctor(await base(home, { root }))) as Report
    expect(line(built, 'dist/:')?.level).toBe(PASS)
  })

  it('checks token mode on POSIX and presence on all platforms', async () => {
    const home = installedHome()
    const officeHome = join(home, '.agent-office')
    mkdirSync(officeHome, { recursive: true })
    const token = join(officeHome, 'auth-token')
    writeFileSync(token, 'secret\n')
    if (process.platform !== 'win32') {
      chmodSync(token, 0o644)
      const loose = (await runDoctor(await base(home))) as Report
      expect(line(loose, 'token:')?.level).toBe(FAIL)
      chmodSync(token, 0o600)
    }
    const ok = (await runDoctor(await base(home))) as Report
    expect(line(ok, 'token:')?.level).toBe(PASS)
  })
})

describe('runDoctor against a running server', () => {
  let office: Office
  let port: number

  beforeAll(async () => {
    office = await loadOffice()
    port = await listen(office.server.httpServer)
  })

  afterAll(async () => {
    office.server.app.locals.health.stop()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('reports running server, missing token as FAIL, and hooks reaching server once posted', async () => {
    const home = installedHome()
    const r = (await runDoctor(await base(home, { port }))) as Report
    expect(line(r, 'server:')?.level).toBe(PASS)
    expect(line(r, 'hooks reaching the server:')?.level).toBe(WARN)
    expect(line(r, 'token:')?.level).toBe(FAIL)
    expect(r.ok).toBe(false)

    writeFileSync(office.server.TOKEN_FILE, `${office.server.AUTH_TOKEN}\n`, { mode: 0o600 })
    await postEvent(office.server, { type: 'session_started', sessionId: 'antigravity:s-doctor', client: 'antigravity', project: 'office', cwd: '/tmp/office' })
    const r2 = (await runDoctor(await base(home, { port, officeHome: office.dir }))) as Report
    expect(line(r2, 'server:')?.title).toContain(`on :${port} — 1 session(s)`)
    expect(line(r2, 'hooks reaching the server:')?.level).toBe(PASS)
    expect(line(r2, 'token:')?.level).toBe(PASS)
    expect(r2.ok).toBe(true)
  })
})

describe('npm run doctor (the script)', () => {
  function run(home: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
    return spawnSync(process.execPath, [DOCTOR, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENT_OFFICE_HOME: join(home, '.agent-office'), NO_COLOR: '1', ...extraEnv },
    })
  }

  it('prints report and exits 0 when healthy, 1 on FAIL, supports --json and --help', async () => {
    const home = installedHome()
    const port = String(await freePort())
    const res = run(home, { AGENT_OFFICE_PORT: port })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/^Antigravity Office doctor/)
    expect(res.stdout).toMatch(/^  PASS  node v\d+/m)
    expect(res.stdout).toMatch(/^  PASS  hooks: 5\/5 events run /m)
    expect(res.stdout).toContain(COMMANDS.install)

    const empty = run(tmp('doctor-fail-'), { AGENT_OFFICE_PORT: port })
    expect(empty.status).toBe(1)
    expect(empty.stdout).toMatch(/^  FAIL  hooks: not installed/m)

    const jsonRes = run(home, { AGENT_OFFICE_PORT: port }, ['--json'])
    expect(jsonRes.status).toBe(0)
    expect(JSON.parse(jsonRes.stdout).ok).toBe(true)

    const helpRes = run(tmp('doctor-help-'), {}, ['--help'])
    expect(helpRes.status).toBe(0)
    expect(helpRes.stdout).toContain('Usage: npm run doctor')
  })
})
