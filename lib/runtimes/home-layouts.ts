// Where each CLI keeps its per-user home, for the linked-home identity
// strategy (`./linked-home.ts`).
//
// Separate from `./catalog.ts` on purpose: the catalog imports icon
// components for the picker, and `collections/RuntimeProfiles.ts` — which is
// loaded by the Payload config, migrations and every CLI script — needs only
// these plain records to enumerate the `homeStrategy` select. A collection
// file that pulls a React icon library into `payload migrate` would be a
// strange thing to explain.
//
// Every entry here relocates its whole home through a single environment
// variable — verified for Claude Code (`CLAUDE_CONFIG_DIR`), Codex
// (`CODEX_HOME`) and OpenCode (`OPENCODE_CONFIG_DIR`, whose docs call it "a
// custom config directory"). That is what makes one generic strategy
// possible instead of one per CLI.

export interface RuntimeHomeLayout {
  /** The environment variable the CLI reads to find its home. */
  envVar: string
  /** Where that home lives by default, as path segments under the user's
   * home directory. Segments, not a string, so the server joins them with
   * the right separator for its platform. */
  defaultDir: string[]
  /** The subdirectory of that home holding one `<name>/SKILL.md` per skill.
   * This is the identity boundary the strategy rebuilds per agent. */
  skillsDir: string
  /** Entries of the base home that must NOT be passed through into an
   * overlay, beyond `skillsDir`. Sidecar state a second process must not
   * share, typically. */
  excludeEntries?: string[]
}

/**
 * One home layout per catalog entry that has one, keyed by the strategy id
 * stored in `runtime_profiles.home_strategy`. `hermes` and `none` are the
 * app's own strategies and are not here.
 */
export const RUNTIME_HOME_LAYOUTS: Readonly<Record<string, { label: string; layout: RuntimeHomeLayout }>> = {
  'claude-home': {
    label: 'Claude Code home (CLAUDE_CONFIG_DIR)',
    layout: {
      envVar: 'CLAUDE_CONFIG_DIR',
      defaultDir: ['.claude'],
      skillsDir: 'skills',
      // Claude's own session transcripts and todo state are per-machine
      // working files; two overlays pointing at one copy is asking for a
      // lock collision.
      excludeEntries: ['projects', 'todos', 'shell-snapshots', 'statsig'],
    },
  },
  'codex-home': {
    label: 'Codex home (CODEX_HOME)',
    layout: {
      envVar: 'CODEX_HOME',
      defaultDir: ['.codex'],
      skillsDir: 'skills',
      // Codex keeps session history and its state databases at the home
      // root. Passing those through is fine for one process; excluding the
      // log directory keeps overlays from writing into the shared install.
      excludeEntries: ['log'],
    },
  },
  'opencode-home': {
    label: 'OpenCode home (OPENCODE_CONFIG_DIR)',
    layout: {
      envVar: 'OPENCODE_CONFIG_DIR',
      defaultDir: ['.config', 'opencode'],
      skillsDir: 'skills',
    },
  },
}

/**
 * The strategy ids the layouts contribute, for the collection's select and
 * the registry.
 */
export const CATALOG_HOME_STRATEGIES: ReadonlyArray<{ value: string; label: string }> = Object.entries(
  RUNTIME_HOME_LAYOUTS,
).map(([value, { label }]) => ({ value, label }))

export function homeLayoutFor(homeStrategy: string | null | undefined): RuntimeHomeLayout | undefined {
  if (!homeStrategy) return undefined
  return RUNTIME_HOME_LAYOUTS[homeStrategy]?.layout
}
