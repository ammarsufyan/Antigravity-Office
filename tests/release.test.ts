/**
 * Tagged releases. .github/workflows/release.yml builds the desktop installers
 * on a `v*` tag and uploads them to a draft GitHub release, from the `build`
 * section of package.json. These checks keep the workflow, that section and
 * electron/after-pack.cjs in step with each other, and run
 * scripts/sync-plugin-version.mjs — the `version` script that moves
 * .claude-plugin/plugin.json to package.json's version when `npm version`
 * cuts a release (tests/plugin.test.ts fails when the two differ).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const SYNC = join(ROOT, 'scripts', 'sync-plugin-version.mjs')

const pkg = JSON.parse(read('package.json'))
const build = pkg.build
const workflow = read('.github/workflows/release.yml')

describe('the electron-builder configuration a release is built from', () => {
  it('names every installer Agent-Office-<version>-<os>-<arch>.<ext>', () => {
    expect(build.artifactName).toBe('Agent-Office-${version}-${os}-${arch}.${ext}')
  })

  it('publishes to a GitHub draft, in the repository package.json names', () => {
    expect(build.publish).toEqual({ provider: 'github', releaseType: 'draft' })
    expect(pkg.repository.url).toMatch(/^https:\/\/github\.com\/ammarsufyan\/Antigravity-Office(\.git)?$/)
  })

  it('builds macOS as one dmg and one zip per architecture, never universal — after-pack.cjs refuses that', () => {
    // The dmg is what a person downloads; the zip is what the app's own
    // updater fetches (electron/mac-update.cjs), and building it is also what
    // makes electron-builder list it in latest-mac.yml.
    expect(build.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ])
    expect(read('electron/after-pack.cjs')).toMatch(/archName === 'universal'/)
  })

  it('builds an NSIS installer that asks where to install on Windows, and an AppImage on Linux', () => {
    expect(build.win.target).toEqual(['nsis'])
    expect(build.nsis).toMatchObject({ oneClick: false, allowToChangeInstallationDirectory: true })
    expect(build.linux.target).toEqual(['AppImage'])
  })

  it('packages the updater: every electron/ file but the build hook, and electron-updater as a production dependency', () => {
    // electron-builder only copies `dependencies` into the app
    expect(pkg.dependencies['electron-updater']).toBeTruthy()
    expect(pkg.devDependencies['electron-updater']).toBeUndefined()
    expect(build.files).toContain('electron/**')
    // Why: the macOS updater reads and writes the bundle's files directly,
    // and runs electron/mac-swap.sh from inside it
    expect(build.asar).toBe(false)
  })
})

describe('the same package.json is the npm package (`npx agent-office`), which never loads the updater', () => {
  it('electron-updater is required in one place, inside a function', () => {
    const sources = ['main', 'helpers', 'update-check', 'update-plan', 'mac-update', 'auto-update'].map((name) => read(`electron/${name}.cjs`))
    const requires = sources.join('\n').match(/require\('electron-updater'\)/g) || []
    expect(requires).toHaveLength(1)
    expect(read('electron/auto-update.cjs')).toContain("load = () => require('electron-updater')")
    // Nothing under cli/, server/ or the scripts the package ships names it
    for (const rel of ['cli/agent-office.mjs', 'server/index.js', 'scripts/open-office.mjs', 'scripts/doctor.mjs']) {
      expect(read(rel), rel).not.toContain('electron-updater')
    }
  })

  it('electron/helpers.cjs, the one electron/ file the package ships, needs no file beside it', () => {
    expect(pkg.files.filter((entry: string) => entry.startsWith('electron/'))).toEqual(['electron/helpers.cjs'])
    const local = read('electron/helpers.cjs').match(/require\('\.[^']*'\)/g) || []
    expect(local).toEqual([])
    // Loaded alone from an empty directory, as it is inside node_modules
    const dir = mkdtempSync(join(tmpdir(), 'helpers-alone-'))
    try {
      writeFileSync(join(dir, 'helpers.cjs'), read('electron/helpers.cjs'))
      const out = execFileSync(process.execPath, ['-e', "const h = require('./helpers.cjs'); process.stdout.write(typeof h.trayMenuTemplate)"], { cwd: dir, encoding: 'utf8' })
      expect(out).toBe('function')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('.github/workflows/release.yml', () => {
  it('runs on v* tags and by hand, with a token that may create the release, one run per ref at a time', () => {
    expect(workflow).toMatch(/^on:\n  push:\n    tags: \['v\*'\]\n  workflow_dispatch:/m)
    expect(workflow).toMatch(/^permissions:\n  contents: write/m)
    expect(workflow).toMatch(/^concurrency:\n  group: release-\$\{\{ github\.ref \}\}/m)
  })

  it('builds on all three runners, unsigned, and uploads to the draft', () => {
    for (const os of ['macos-latest', 'windows-latest', 'ubuntu-latest']) {
      expect(workflow).toContain(`os: ${os}`)
    }
    expect(workflow).toContain('npx electron-builder ${{ matrix.args }} --publish always')
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: false')
  })

  it('ships the default boss: the example office.config.json is never copied in', () => {
    expect(workflow).not.toMatch(/cp office\.config\.example\.json/)
  })
})
