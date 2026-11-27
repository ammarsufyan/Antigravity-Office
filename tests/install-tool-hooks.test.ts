/**
 * scripts/install-tool-hooks.mjs — Antigravity hook installer: merges only
 * our antigravity-office block into ~/.gemini/config/hooks.json, keeps an exact
 * backup, refuses symlinks, and stays idempotent across Windows/macOS/Linux.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { install, main, status, targetFile, TOOL_IDS, uninstall } from '../scripts/install-tool-hooks.mjs'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const tmp = (prefix = 'install-agy-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }
const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }

describe('install-tool-hooks (Antigravity)', () => {
  it('installs the 5 safe Antigravity events (never PreToolUse), stays idempotent, and restores original bytes on uninstall', () => {
    const home = tmp('agy-home-')
    const hooksDir = tmp('agy-hooks-')
    const file = targetFile('antigravity', home)
    const original = JSON.stringify({ other: { Stop: [{ type: 'command', command: 'echo keep' }] } }, null, 2) + '\n'
    write(file, original)

    const first = install('antigravity', { home, hooksDir })
    expect(first.changed).toEqual([file])

    const installed = JSON.parse(readFileSync(file, 'utf8'))
    expect(installed.other).toEqual({ Stop: [{ type: 'command', command: 'echo keep' }] })
    expect(Object.keys(installed['antigravity-office']).sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreInvocation', 'SessionStart', 'Stop'])
    expect(installed['antigravity-office']).not.toHaveProperty('PreToolUse')
    expect(installed['antigravity-office'].Stop[0].command).toContain('antigravity-relay.mjs" Stop')
    expect(installed['antigravity-office'].PostToolUse[0].hooks[0].command).toContain('antigravity-relay.mjs" PostToolUse')

    // Second install is a no-op
    expect(install('antigravity', { home, hooksDir }).changed).toEqual([])
    expect(status('antigravity', { home })).toBe('connected')

    // Uninstall restores original bytes
    expect(uninstall('antigravity', { home }).changed).toEqual([file])
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(status('antigravity', { home })).toBe('not-connected')
  })

  it('removes a legacy claude-office entry on install and uninstall', () => {
    const home = tmp('agy-legacy-')
    const hooksDir = tmp('agy-hooks-')
    const file = targetFile('antigravity', home)
    write(file, JSON.stringify({ 'claude-office': { Stop: [{ type: 'command', command: 'python3 office-relay.py antigravity Stop' }] } }, null, 2))

    install('antigravity', { home, hooksDir })
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    expect(cfg).not.toHaveProperty('claude-office')
    expect(cfg).toHaveProperty('antigravity-office')
  })

  it('deletes hooks.json on uninstall when we created it', () => {
    const home = tmp('agy-new-')
    const hooksDir = tmp('agy-hooks-')
    const file = targetFile('antigravity', home)
    expect(status('antigravity', { home })).toBe('not-installed')

    install('antigravity', { home, hooksDir })
    expect(existsSync(file)).toBe(true)
    expect(status('antigravity', { home })).toBe('connected')

    uninstall('antigravity', { home })
    expect(existsSync(file)).toBe(false)
  })

  it('refuses a symlinked hooks.json', () => {
    if (process.platform === 'win32') return
    const home = tmp('agy-sym-')
    const hooksDir = tmp('agy-hooks-')
    const real = join(tmp('agy-real-'), 'hooks.json')
    write(real, '{}')
    const file = targetFile('antigravity', home)
    mkdirSync(dirname(file), { recursive: true })
    symlinkSync(real, file)
    expect(() => install('antigravity', { home, hooksDir })).toThrow(/symlink/)
    expect(() => uninstall('antigravity', { home })).toThrow(/symlink/)
  })

  it('CLI defaults to antigravity when --tool is omitted, and rejects unknown tools', () => {
    expect(TOOL_IDS).toEqual(['antigravity'])
    const home = tmp('agy-cli-')
    const hooksDir = tmp('agy-hooks-')
    const out = { text: '', write(s: string) { this.text += s; return true } }
    const err = { text: '', write(s: string) { this.text += s; return true } }

    expect(main(['--hooks-dir', hooksDir], { home, out, err })).toBe(0)
    expect(existsSync(targetFile('antigravity', home))).toBe(true)
    expect(main(['--uninstall', '--hooks-dir', hooksDir], { home, out, err })).toBe(0)
    expect(existsSync(targetFile('antigravity', home))).toBe(false)

    expect(main(['--tool', 'nope'], { home, out, err })).toBe(2)
    expect(err.text).toContain('antigravity')
  })
})
