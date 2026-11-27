/**
 * cli/agent-office.mjs — argument parsing, hooks-path resolution (checkout vs
 * $AGENT_OFFICE_HOME/hooks copy), install-hooks / doctor / uninstall-hooks,
 * and start --detach / stop. Pure Node.js across Windows, macOS, and Linux.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { copyHooks, HOOK_FILES, isCheckout, main, npxCommands, parseArgs, resolveHooksDir } from '../cli/agent-office.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(ROOT, 'cli', 'agent-office.mjs')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
function tempDir(prefix = 'agent-office-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function sink() {
  const s = { text: '', isTTY: false, write(chunk: string) { s.text += chunk; return true } }
  return s
}

function isolatedEnv(extra: Record<string, string> = {}) {
  const home = tempDir('agent-office-cli-home-')
  const { AGENT_OFFICE_HOME: _h, AGENT_OFFICE_PORT: _p, AGENT_OFFICE_UI_DIR: _u, AGENT_OFFICE_CONFIG_DIR: _cfg, ...env } = process.env
  return {
    home,
    env: { ...env, HOME: home, USERPROFILE: home, AGENT_OFFICE_HOME: join(home, '.agent-office'), NO_COLOR: '1', ...extra } as NodeJS.ProcessEnv,
  }
}

function npxCopy() {
  const cache = tempDir('agent-office-npx-')
  const root = join(cache, 'node_modules', 'antigravity-office')
  mkdirSync(root, { recursive: true })
  for (const p of ['package.json', 'hooks.json', 'hooks']) cpSync(join(ROOT, p), join(root, p), { recursive: true })
  return { cache, root }
}

describe('parseArgs', () => {
  it('runs start when no command is given, with any start flag', () => {
    expect(parseArgs([])).toMatchObject({ command: 'start' })
    expect(parseArgs(['--no-open']).command).toBe('start')
    expect(parseArgs(['--no-open']).flags.has('--no-open')).toBe(true)
    expect(parseArgs(['start', '-d']).flags.has('-d')).toBe(true)
  })

  it('accepts each command with its own flags', () => {
    expect(parseArgs(['install-hooks'])).toMatchObject({ command: 'install-hooks' })
    expect(parseArgs(['install-hooks', '--tool', 'antigravity'])).toMatchObject({ command: 'install-hooks', tool: 'antigravity' })
    expect(parseArgs(['uninstall-hooks'])).toMatchObject({ command: 'uninstall-hooks' })
    expect(parseArgs(['doctor', '--json'])).toMatchObject({ command: 'doctor' })
    expect(parseArgs(['stop', '--force'])).toMatchObject({ command: 'stop' })
    expect(parseArgs(['open', '--print'])).toMatchObject({ command: 'open' })
  })

  it('refuses an unknown command, a stray argument, or a flag of another command', () => {
    expect(parseArgs(['serve']).error).toBe('Unknown command: serve')
    expect(parseArgs(['start', 'now']).error).toBe('Unexpected argument: now')
    expect(parseArgs(['start', '--json']).error).toBe('Unknown option for start: --json')
    expect(parseArgs(['doctor', '--detach']).error).toBe('Unknown option for doctor: --detach')
    expect(parseArgs(['install-hooks', '--tool', 'nope']).error).toContain('antigravity')
    expect(parseArgs(['doctor', '--tool', 'antigravity']).error).toBeTruthy()
  })

  it('--help and --version win over everything else', () => {
    expect(parseArgs(['doctor', '--help']).command).toBe('help')
    expect(parseArgs(['help']).command).toBe('help')
    expect(parseArgs(['-h', 'serve']).command).toBe('help')
    expect(parseArgs(['--version']).command).toBe('version')
    expect(parseArgs(['start', '-v']).command).toBe('version')
  })

  it('--port takes a port number in either spelling and refuses anything else', () => {
    expect(parseArgs(['--port', '3401'])).toMatchObject({ command: 'start', port: 3401 })
    expect(parseArgs(['doctor', '--port=3402'])).toMatchObject({ command: 'doctor', port: 3402 })
    expect(parseArgs(['--port']).error).toContain('got nothing')
    expect(parseArgs(['--port', '0']).error).toContain('1-65535')
    expect(parseArgs(['--port', '70000']).error).toContain('1-65535')
    expect(parseArgs(['--port=abc']).error).toContain('"abc"')
  })
})

describe('main: help, version, usage errors', () => {
  it('prints the version from package.json and the usage under the npx name', async () => {
    const out = sink()
    expect(await main(['--version'], { out, err: sink() })).toBe(0)
    expect(out.text.trim()).toBe(pkg.version)
    const help = sink()
    expect(await main(['--help'], { out: help, err: sink() })).toBe(0)
    expect(help.text).toContain(`Usage: npx ${pkg.name} [command]`)
    for (const c of ['start', 'open', 'stop', 'install-hooks', 'uninstall-hooks', 'doctor']) expect(help.text).toContain(c)
  })

  it('exits 2 with the error and the usage on a bad command line', async () => {
    const err = sink()
    expect(await main(['bogus'], { out: sink(), err })).toBe(2)
    expect(err.text).toContain('Unknown command: bogus')
    expect(err.text).toContain('Usage:')
  })

  it('runs as the bin', () => {
    const res = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe(pkg.version)
    expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
    expect(pkg.bin['antigravity-office']).toBe('cli/agent-office.mjs')
  })
})

describe('where the hooks live', () => {
  it('a git checkout keeps its own hooks/', () => {
    expect(isCheckout(ROOT)).toBe(true)
    expect(resolveHooksDir({ root: ROOT, officeHome: '/h/.agent-office' })).toEqual({ dir: join(ROOT, 'hooks'), copy: false })
  })

  it('an installed package copies hooks to $AGENT_OFFICE_HOME/hooks', () => {
    const exists = () => true
    for (const root of [join('/Users', 'a', '.npm', '_npx', '0c1d', 'node_modules', 'antigravity-office'), join('/usr', 'local', 'lib', 'node_modules', 'antigravity-office')]) {
      expect(resolveHooksDir({ root, officeHome: '/h/.agent-office', exists })).toEqual({ dir: join('/h/.agent-office', 'hooks'), copy: true })
    }
    expect(resolveHooksDir({ root: '/opt/antigravity-office', officeHome: '/h/.agent-office', exists: () => false })).toEqual({ dir: join('/h/.agent-office', 'hooks'), copy: true })
  })

  it('copyHooks writes antigravity-relay.mjs whole and replaces stale copies', () => {
    const dest = join(tempDir(), 'office', 'hooks')
    copyHooks(join(ROOT, 'hooks'), dest)
    expect(readdirSync(dest).sort()).toEqual([...HOOK_FILES].sort())
    for (const f of HOOK_FILES) {
      expect(readFileSync(join(dest, f)).equals(readFileSync(join(ROOT, 'hooks', f)))).toBe(true)
    }
    writeFileSync(join(dest, 'antigravity-relay.mjs'), 'stale')
    copyHooks(join(ROOT, 'hooks'), dest)
    expect(readFileSync(join(dest, 'antigravity-relay.mjs')).equals(readFileSync(join(ROOT, 'hooks', 'antigravity-relay.mjs')))).toBe(true)
  })
})

describe('install-hooks / doctor / uninstall-hooks from an npx copy', () => {
  it('points ~/.gemini/config/hooks.json at the stable copy, which keeps working after cache deletion', async () => {
    const { home, env } = isolatedEnv()
    const { cache, root } = npxCopy()
    const out = sink()
    const err = sink()
    expect(await main(['install-hooks'], { root, env, out, err })).toBe(0)
    const stable = join(home, '.agent-office', 'hooks')
    expect(out.text).toContain(`Copied the hook scripts to ${stable}`)

    const hooksFile = join(home, '.gemini', 'config', 'hooks.json')
    const cfg = JSON.parse(readFileSync(hooksFile, 'utf8'))
    expect(cfg['antigravity-office'].Stop[0].command).toContain(join(stable, 'antigravity-relay.mjs').replace(/\\/g, '/'))

    // Cache cleaned: relay still lives in stable copy
    rmSync(cache, { recursive: true, force: true })
    for (const f of HOOK_FILES) expect(existsSync(join(stable, f))).toBe(true)

    // doctor from a fresh copy accepts the stable copy and names npx commands
    const later = npxCopy().root
    const report = sink()
    await main(['doctor', '--no-color', '--port', '1'], { root: later, env, out: report, err: sink() })
    expect(report.text).toMatch(/PASS  hooks: 5\/5 events run /)
    expect(report.text).toContain('PASS  hook files')
    expect(report.text).toContain(npxCommands(`npx ${pkg.name}`).install)

    // uninstall removes entries and deletes the stable copy
    expect(await main(['uninstall-hooks'], { root: later, env, out: sink(), err: sink() })).toBe(0)
    expect(existsSync(hooksFile)).toBe(false)
    expect(existsSync(stable)).toBe(false)
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

describe('start --detach / stop', () => {
  it('serves the built UI and /health on the chosen port, then stops by pid file', async () => {
    const ui = tempDir('agent-office-cli-ui-')
    writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Antigravity Office</title>')
    const { home, env } = isolatedEnv({ AGENT_OFFICE_UI_DIR: ui })
    const port = await freePort()
    const res = spawnSync(process.execPath, [BIN, 'start', '--detach', '--no-open', '--port', String(port)], { env, encoding: 'utf8', timeout: 25_000 })
    const out = { text: res.stdout }
    try {
      expect(res.stderr).toBe('')
      expect(res.status).toBe(0)
      expect(out.text).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${port}/#token=[0-9a-f]{64}`))
      expect(out.text).toContain(`npx ${pkg.name} stop`)
      expect((await fetch(`http://127.0.0.1:${port}/`).then(r => r.text()))).toContain('<title>Antigravity Office</title>')
      expect((await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())).status).toBe('ok')
      const log = join(home, '.agent-office', 'server.log')
      if (process.platform !== 'win32') expect(statSync(log).mode & 0o777).toBe(0o600)
      const again = sink()
      expect(await main(['start', '--no-open', '--port', String(port)], { env, out: again, err: sink() })).toBe(0)
      expect(again.text).toContain(`already answering on port ${port}`)
    } finally {
      const stop = sink()
      expect(await main(['stop', '--port', String(port)], { env, out: stop, err: sink() })).toBe(0)
      expect(stop.text).toContain('Server stopped')
    }
    await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  }, 30_000)

  it('refuses to start without a built UI', async () => {
    const { env } = isolatedEnv({ AGENT_OFFICE_UI_DIR: tempDir() })
    const err = sink()
    expect(await main(['start', '--no-open', '--port', String(await freePort())], { env, out: sink(), err })).toBe(1)
    expect(err.text).toContain('The office UI is not built')
  })
})
