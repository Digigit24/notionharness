import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { catalogEntry } from '../catalog'
import { buildLinkedHome, createLinkedHomeStrategy, resolveBaseHome } from '../linked-home'
import { getRuntimeHomeStrategy } from '../home'
import '../registry'

const codex = catalogEntry('codex')!
const layout = codex.home!

let root: string
let baseHome: string
let overlayRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'linked-home-test-'))
  baseHome = join(root, 'base')
  overlayRoot = join(root, 'overlays')
  // A fake ~/.codex: config, credentials, a log dir (excluded by the layout)
  // and a skills pool of two.
  await mkdir(join(baseHome, 'skills', 'review'), { recursive: true })
  await mkdir(join(baseHome, 'skills', 'deploy'), { recursive: true })
  await mkdir(join(baseHome, 'log'), { recursive: true })
  await mkdir(join(baseHome, 'sessions'), { recursive: true })
  await writeFile(join(baseHome, 'config.toml'), 'model = "gpt-5"\n')
  await writeFile(join(baseHome, 'auth.json'), '{"token":"x"}\n')
  await writeFile(join(baseHome, 'skills', 'review', 'SKILL.md'), '# review\n')
  await writeFile(join(baseHome, 'skills', 'deploy', 'SKILL.md'), '# deploy\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
})

describe('buildLinkedHome', () => {
  it('links config through, rebuilds skills from the enabled list, and points the env var at the overlay', async () => {
    const overlay = await buildLinkedHome(layout, {
      runId: 'run-1',
      agentId: 7,
      conversationId: 'c1',
      enabledSkills: ['review', 'missing-one'],
      baseHome,
      overlayRoot,
    })
    try {
      expect(overlay.env).toEqual({ CODEX_HOME: overlay.homeDir })
      expect(overlay.homeDir).toBe(join(overlayRoot, 'run-1'))
      // Config and credentials are the live shared copies.
      expect(await readFile(join(overlay.homeDir, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n')
      expect(await readFile(join(overlay.homeDir, 'auth.json'), 'utf8')).toBe('{"token":"x"}\n')
      expect(existsSync(join(overlay.homeDir, 'sessions'))).toBe(true)
      // The layout's excluded entry is not passed through.
      expect(existsSync(join(overlay.homeDir, 'log'))).toBe(false)
      // Skills: only what the agent enabled, and the missing one is named.
      expect((await readdir(join(overlay.homeDir, 'skills'))).sort()).toEqual(['review'])
      expect(await readFile(join(overlay.homeDir, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('# review\n')
      expect(overlay.missingSkills).toEqual(['missing-one'])
    } finally {
      await overlay.cleanup()
    }
    // Cleanup removes the overlay and nothing it linked to.
    expect(existsSync(overlay.homeDir)).toBe(false)
    expect(existsSync(join(baseHome, 'skills', 'review', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(baseHome, 'config.toml'))).toBe(true)
  })

  it('relocates nothing when the CLI has no home yet, and says every skill is missing', async () => {
    const overlay = await buildLinkedHome(layout, {
      runId: 'run-2',
      agentId: 7,
      conversationId: 'c1',
      enabledSkills: ['review'],
      baseHome: join(root, 'does-not-exist'),
      overlayRoot,
    })
    expect(overlay.env).toEqual({})
    expect(overlay.missingSkills).toEqual(['review'])
    expect(existsSync(overlay.homeDir)).toBe(false)
    await overlay.cleanup()
  })

  it('accepts the skills field in either of its stored shapes', async () => {
    const overlay = await buildLinkedHome(layout, {
      runId: 'run-3',
      agentId: 7,
      conversationId: 'c1',
      enabledSkills: [{ name: 'deploy' }, 'review'] as unknown as string[],
      baseHome,
      overlayRoot,
    })
    try {
      expect((await readdir(join(overlay.homeDir, 'skills'))).sort()).toEqual(['deploy', 'review'])
      expect(overlay.missingSkills).toEqual([])
    } finally {
      await overlay.cleanup()
    }
  })
})

describe('resolveBaseHome', () => {
  it("prefers the server's own env var over the documented default", () => {
    expect(resolveBaseHome(layout, { CODEX_HOME: join(root, 'elsewhere') })).toBe(join(root, 'elsewhere'))
    expect(resolveBaseHome(layout, {})).toMatch(/[\\/]\.codex$/)
    expect(resolveBaseHome(catalogEntry('opencode')!.home!, {})).toMatch(/[\\/]\.config[\\/]opencode$/)
  })
})

describe('registry', () => {
  it('registers a linked-home strategy for every catalog entry with a layout, and leaves hermes/none alone', () => {
    expect(getRuntimeHomeStrategy('codex-home').id).toBe('codex-home')
    expect(getRuntimeHomeStrategy('opencode-home').id).toBe('opencode-home')
    expect(getRuntimeHomeStrategy('claude-home').id).toBe('claude-home')
    expect(getRuntimeHomeStrategy('hermes').id).toBe('hermes')
    expect(getRuntimeHomeStrategy('none').id).toBe('none')
    expect(getRuntimeHomeStrategy('never-heard-of-it').id).toBe('none')
  })

  it('refuses to build a strategy for an entry without a layout', () => {
    expect(() => createLinkedHomeStrategy(catalogEntry('hermes')!)).toThrow(/no home layout/)
  })
})
