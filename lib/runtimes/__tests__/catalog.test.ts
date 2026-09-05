import { describe, expect, it } from 'vitest'
import {
  CATALOG_HOME_STRATEGIES,
  RUNTIME_CATALOG,
  catalogEntry,
  catalogEntryCommandLine,
  catalogEntryForCommand,
  catalogEntryForHomeStrategy,
  isCatalogEntryReady,
} from '../catalog'
import { RUNTIME_HOME_LAYOUTS, homeLayoutFor } from '../home-layouts'

describe('runtime catalog', () => {
  it('gives every entry a command, a detect command, and a way in', () => {
    expect(RUNTIME_CATALOG.map((e) => e.id)).toEqual(['hermes', 'claude-code', 'codex', 'opencode', 'gemini', 'goose'])
    for (const entry of RUNTIME_CATALOG) {
      expect(entry.command.trim().length).toBeGreaterThan(0)
      expect(entry.detectCommand).not.toMatch(/\s/)
      expect(entry.installCommand.length).toBeGreaterThan(0)
      expect(entry.signInCommand.length).toBeGreaterThan(0)
      expect(entry.homeStrategy.length).toBeGreaterThan(0)
      expect(['verified', 'documented', 'illustrative']).toContain(entry.commandConfidence)
    }
  })

  it('only claims a home layout for entries the strategy can actually relocate', () => {
    for (const entry of RUNTIME_CATALOG) {
      if (entry.home) {
        expect(RUNTIME_HOME_LAYOUTS[entry.homeStrategy]?.layout).toBe(entry.home)
        expect(homeLayoutFor(entry.homeStrategy)).toBe(entry.home)
      } else {
        expect(['hermes', 'none']).toContain(entry.homeStrategy)
      }
    }
    const envVars = new Set(Object.values(RUNTIME_HOME_LAYOUTS).map((h) => h.layout.envVar))
    expect(envVars.size).toBe(Object.keys(RUNTIME_HOME_LAYOUTS).length)
    expect(CATALOG_HOME_STRATEGIES.map((s) => s.value)).toEqual(Object.keys(RUNTIME_HOME_LAYOUTS))
    // Neither of the app's own ids may be shadowed by a layout.
    expect(RUNTIME_HOME_LAYOUTS.hermes).toBeUndefined()
    expect(RUNTIME_HOME_LAYOUTS.none).toBeUndefined()
  })

  it('names Codex and OpenCode the way their ACP docs do, and marks them verified', () => {
    const codex = catalogEntry('codex')!
    expect(catalogEntryCommandLine(codex)).toBe('codex-acp')
    expect(codex.home?.envVar).toBe('CODEX_HOME')
    expect(codex.commandConfidence).toBe('verified')
    const opencode = catalogEntry('opencode')!
    expect(catalogEntryCommandLine(opencode)).toBe('opencode acp')
    expect(opencode.home?.envVar).toBe('OPENCODE_CONFIG_DIR')
    expect(opencode.commandConfidence).toBe('verified')
    expect(catalogEntry('gemini')?.commandConfidence).toBe('illustrative')
  })

  it('matches a stored command back to its entry, hand-typed or not', () => {
    expect(catalogEntryForCommand('opencode acp')?.id).toBe('opencode')
    expect(catalogEntryForCommand('C:\\tools\\opencode.exe acp')?.id).toBe('opencode')
    expect(catalogEntryForCommand('codex-acp')?.id).toBe('codex')
    expect(catalogEntryForCommand('npx -y @agentclientprotocol/codex-acp')?.id).toBe('codex')
    expect(catalogEntryForCommand('/usr/local/bin/hermes-acp')?.id).toBe('hermes')
    expect(catalogEntryForCommand('claude-agent-acp')?.id).toBe('claude-code')
    expect(catalogEntryForCommand('npx -y @zed-industries/claude-code-acp')?.id).toBe('claude-code')
    expect(catalogEntryForCommand('some-other-agent --acp')).toBeUndefined()
    expect(catalogEntryForCommand('')).toBeUndefined()
  })

  it('resolves a strategy id back to its entry', () => {
    expect(catalogEntryForHomeStrategy('codex-home')?.id).toBe('codex')
    expect(catalogEntryForHomeStrategy('hermes')?.id).toBe('hermes')
    expect(catalogEntryForHomeStrategy('none')?.id).toBe('gemini')
  })

  it('reports readiness only from an existing probed profile, never from a guess', () => {
    const codex = catalogEntry('codex')!
    expect(isCatalogEntryReady(codex, new Set())).toBe(false)
    expect(isCatalogEntryReady(codex, new Set(['codex-acp']))).toBe(true)
  })
})
