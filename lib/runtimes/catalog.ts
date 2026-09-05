// The runtime catalog: every ACP CLI this app knows how to set up, as data.
//
// Two histories meet here. R14-P0.6 wrote this file as a hand-maintained list
// of runtime KINDS for the "+ Add runtimes" picker, with an honest
// `commandConfidence` per entry because most of them had never been run from
// this codebase. R15 then verified the ones that matter live — Codex and
// OpenCode were probed and ran a real turn on the dev machine, Claude Code's
// adapter was installed and resolved — and added what a person needs beyond
// the command: how to install the CLI, how to sign it in, which env var
// stands in for a sign-in, and where it keeps its home so an agent can have
// its own skills there (`./linked-home.ts`). This is the union.
//
// D2 STILL GOVERNS. An entry says how to REACH a runtime — a command, its
// arguments, its install and sign-in commands, its home on disk. It asserts
// NOTHING about what that runtime can do. Capability claims (can it resume a
// session, does it offer model selection, what config options and modes it
// exposes) come only from that runtime's own ACP `initialize`/`session/new`
// handshake, stored verbatim on the profile after a real probe
// (`lib/runtimes/detect.ts`, `probeAcpRuntime`).
//
// CONFIDENCE, three levels, shown in the picker's detail pane:
//   `verified`     — probed AND ran a turn from this codebase, on the dev
//                    machine, through this app's own client. Codex and
//                    OpenCode, as of R15. Hermes, which has run in anger for
//                    the life of the project.
//   `documented`   — the adapter package is real and its bin name resolved
//                    on the dev machine, but no turn has been run through it
//                    from here. Claude Code.
//   `illustrative` — named only because the roadmap names them as plausible
//                    ACP CLIs. Nobody has installed or probed them here, and
//                    the command is honestly likely wrong. Gemini, Goose.
//
// BADGE HONESTY (the "Ready" vs "CLI needed" column). Determining whether a
// given command is actually resolvable on THIS machine's PATH means running
// `resolveCommandPath` (`lib/runtimes/spawn-command.ts`), which spawns a real
// `where`/`which` child process. Doing that for every catalog entry on every
// render of the picker is exactly what D0 forbids. So this file computes NO
// status at all. The picker cross-references the workspace's EXISTING runtime
// profiles by command line (`isCatalogEntryReady`), and an explicit
// "which are installed here?" action (`detectCatalogRuntimes`) spawns the
// lookups once, on request, never on render.
//
// This file imports icon components for the picker. Anything that must load
// without React — the Payload collection, migrations, CLI scripts — takes
// the home layouts from `./home-layouts.ts` instead.
import type { LucideIcon } from 'lucide-react'
import { Bird, Bot, Gem, Sparkles, SquareTerminal, Code2 } from 'lucide-react'
import type { RuntimeProfile } from '@/payload-types'
import { RUNTIME_HOME_LAYOUTS, type RuntimeHomeLayout } from './home-layouts'

export type { RuntimeHomeLayout } from './home-layouts'
export { CATALOG_HOME_STRATEGIES } from './home-layouts'

export type RuntimeCatalogId = 'hermes' | 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'goose'

export interface RuntimeCatalogEntry {
  /** Stable id for this catalog row. Not written anywhere — it only has to be
   * unique within this file and is used to key the picker's list. */
  id: RuntimeCatalogId
  displayName: string
  vendor: string
  icon: LucideIcon
  description: string
  /** `AddRuntimeProfileForm`'s existing protocol-family select. */
  protocolFamily: RuntimeProfile['protocolFamily']
  /** `runtime_profiles.home_strategy` for a profile built from this entry:
   * `hermes`, `none`, or one of the ids in `RUNTIME_HOME_LAYOUTS`. Written by
   * `createRuntimeProfile` when a profile comes from the picker. */
  homeStrategy: string
  /** The executable `spawn` should run. */
  command: string
  /** Fixed arguments after the command, if any. Kept separate from `command`
   * for display in the detail pane; the form folds these back into ONE string
   * before calling `createRuntimeProfile`, using the same "one string, split
   * at spawn time" convention `splitCommand` already relies on. */
  args: string[]
  /**
   * The bare executable whose presence on PATH means "installed", for the
   * on-request detection. For an adapter-driven CLI this is the adapter's own
   * bin — that is what actually has to exist for a run to start.
   */
  detectCommand: string
  /** How the CLI reaches ACP: its own flag or subcommand, or a separate
   * adapter process that drives it. Informational — the run path treats both
   * identically, which is the whole point of the protocol. */
  acpVia: 'native' | 'adapter'
  commandConfidence: 'verified' | 'documented' | 'illustrative'
  /** One sentence naming where `command`/`args` came from, for the detail
   * pane's "Source" line. */
  source: string
  /** The one command that installs the CLI (or its adapter). Shown, never run. */
  installCommand: string
  /** The one command that signs the CLI in on this machine. Shown when a
   * probe reports the runtime wants authentication. */
  signInCommand: string
  /** The environment variable that substitutes for an interactive sign-in,
   * when the CLI accepts one. Null when it does not. */
  apiKeyEnvVar: string | null
  docsUrl: string
  /** Null for a runtime whose home the linked-home strategy cannot relocate
   * (Hermes has its own richer strategy; the illustrative entries are
   * unknown). */
  home: RuntimeHomeLayout | null
}

export const RUNTIME_CATALOG: readonly RuntimeCatalogEntry[] = [
  {
    id: 'hermes',
    displayName: 'Hermes',
    vendor: 'Nous Research',
    icon: Sparkles,
    description:
      'The Hermes agent this install already runs turns through — the runtime this app was built against. Speaks ACP natively; no adapter needed. Profiles, memories and skills are managed from its own settings screens.',
    protocolFamily: 'acp',
    homeStrategy: 'hermes',
    command: 'hermes-acp',
    args: [],
    detectCommand: 'hermes-acp',
    acpVia: 'native',
    commandConfidence: 'verified',
    source: 'lib/acp/client.ts has spawned this exact binary for the life of the project (see AGENTS.md).',
    installCommand: 'See the Hermes Agent docs for this platform',
    signInCommand: 'hermes',
    apiKeyEnvVar: null,
    docsUrl: 'https://github.com/NousResearch/hermes-agent',
    // Hermes has its own, richer strategy (`lib/runtimes/hermes/`): per-agent
    // memories and per-conversation state on top of skills. Not expressed as
    // a layout because that shape is the subset the generic strategy can do.
    home: null,
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    icon: Bot,
    description:
      "Claude Code, reached through Zed's ACP adapter. Claude Code itself speaks the Agent SDK's stream-json protocol, not ACP — this app drives it through the adapter, never the raw `claude` CLI. Sign in once with the CLI, or set ANTHROPIC_API_KEY on the server.",
    protocolFamily: 'acp',
    homeStrategy: 'claude-home',
    command: 'claude-agent-acp',
    args: [],
    detectCommand: 'claude-agent-acp',
    acpVia: 'adapter',
    commandConfidence: 'documented',
    source:
      "Zed's adapter package, @zed-industries/claude-agent-acp: installed and its bin resolved on PATH on the dev machine. No turn has been run through it from this codebase yet — probe after adding.",
    installCommand: 'npm install -g @zed-industries/claude-agent-acp',
    signInCommand: 'claude login',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://github.com/zed-industries/claude-code-acp',
    home: RUNTIME_HOME_LAYOUTS['claude-home'].layout,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    vendor: 'OpenAI',
    icon: SquareTerminal,
    description:
      'OpenAI Codex, reached through the ACP adapter. Codex speaks its own app-server JSON-RPC, not ACP; the adapter translates and finds the codex binary on PATH (or CODEX_PATH). Sign in with ChatGPT once, or set OPENAI_API_KEY.',
    protocolFamily: 'acp',
    homeStrategy: 'codex-home',
    command: 'codex-acp',
    args: [],
    detectCommand: 'codex-acp',
    acpVia: 'adapter',
    commandConfidence: 'verified',
    source:
      '@agentclientprotocol/codex-acp (the successor to zed-industries/codex-acp; same `codex-acp` bin). Probed and ran a turn from this codebase on the dev machine (R15): handshake, auth methods, session, model override and completion all observed live.',
    installCommand: 'npm install -g @agentclientprotocol/codex-acp',
    signInCommand: 'codex login',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    docsUrl: 'https://github.com/agentclientprotocol/codex-acp',
    home: RUNTIME_HOME_LAYOUTS['codex-home'].layout,
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    vendor: 'SST',
    icon: Code2,
    description:
      'OpenCode speaks ACP natively through its `acp` subcommand. Credentials live in its data directory, not its config directory, so relocating the config directory per agent keeps the sign-in.',
    protocolFamily: 'acp',
    homeStrategy: 'opencode-home',
    command: 'opencode',
    args: ['acp'],
    detectCommand: 'opencode',
    acpVia: 'native',
    commandConfidence: 'verified',
    source:
      'opencode.ai/docs/acp. Probed and ran a turn from this codebase on the dev machine (R15), bare and through the linked-home identity strategy: a real session and a real reply.',
    installCommand: 'npm install -g opencode-ai',
    signInCommand: 'opencode auth login',
    apiKeyEnvVar: null,
    docsUrl: 'https://opencode.ai/docs/acp/',
    home: RUNTIME_HOME_LAYOUTS['opencode-home'].layout,
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    vendor: 'Google',
    icon: Gem,
    description:
      "Illustrative placeholder. Named in this app's own roadmap (D1, R10.2b of docs/ROADMAP-SERIES.md) as a plausible ACP-speaking CLI — nobody has installed, inspected or probed it from this codebase. Confirm the real invocation before trusting this entry.",
    protocolFamily: 'acp',
    homeStrategy: 'none',
    command: 'gemini',
    args: [],
    detectCommand: 'gemini',
    acpVia: 'native',
    commandConfidence: 'illustrative',
    source:
      'Unverified guess. `docs/ROADMAP-SERIES.md` names `gemini` as a command worth scanning for, nothing more — no adapter or native-ACP claim has been checked.',
    installCommand: 'npm install -g @google/gemini-cli',
    signInCommand: 'gemini',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    home: null,
  },
  {
    id: 'goose',
    displayName: 'Goose',
    vendor: 'Block',
    icon: Bird,
    description:
      "Illustrative placeholder for Block's Goose agent, same caveat as Gemini above — named only because AionUi supports it; never installed or probed from this codebase.",
    protocolFamily: 'acp',
    homeStrategy: 'none',
    command: 'goose',
    args: [],
    detectCommand: 'goose',
    acpVia: 'native',
    commandConfidence: 'illustrative',
    source: "Unverified guess, named only in docs/ROADMAP-SERIES.md's D1 list of runtimes AionUi already supports.",
    installCommand: 'See the Goose docs for this platform',
    signInCommand: 'goose configure',
    apiKeyEnvVar: null,
    docsUrl: 'https://github.com/block/goose',
    home: null,
  },
]

/** The exact string `AddRuntimeProfileForm`'s single command field expects —
 * `createRuntimeProfile` takes one `commandName` string and this app already
 * splits inline arguments back out of it at spawn time (`splitCommand`). */
export function catalogEntryCommandLine(entry: RuntimeCatalogEntry): string {
  return [entry.command, ...entry.args].join(' ').trim()
}

/**
 * Cheap, DB-only readiness check — see the file header for why this does not
 * spawn anything. `probedCommandLines` is the set of commands among the
 * workspace's EXISTING runtime profiles whose last probe came back `ok`.
 */
export function isCatalogEntryReady(entry: RuntimeCatalogEntry, probedCommandLines: ReadonlySet<string>): boolean {
  return probedCommandLines.has(catalogEntryCommandLine(entry))
}

export function catalogEntry(id: string | null | undefined): RuntimeCatalogEntry | undefined {
  if (!id) return undefined
  return RUNTIME_CATALOG.find((entry) => entry.id === id)
}

/** The catalog entry behind a stored home strategy, if any. */
export function catalogEntryForHomeStrategy(homeStrategy: string | null | undefined): RuntimeCatalogEntry | undefined {
  if (!homeStrategy) return undefined
  return RUNTIME_CATALOG.find((entry) => entry.homeStrategy === homeStrategy)
}

/**
 * Which catalog entry a configured command most plausibly is.
 *
 * Profiles do not store a catalog id — a profile is a command, and a person
 * may have typed one by hand — so this matches on the command itself: the
 * whole configured line, its first token against the entry's command or
 * detect command, or any token against the adapter's package name (a profile
 * written as `npx -y @agentclientprotocol/codex-acp` is still Codex). Used
 * to show the right sign-in hint next to a probe result and to give a
 * hand-typed profile the right home strategy; a miss costs a hint, never a
 * wrong spawn, which is why a heuristic is acceptable.
 */
export function catalogEntryForCommand(commandName: string | null | undefined): RuntimeCatalogEntry | undefined {
  if (!commandName) return undefined
  const trimmed = commandName.trim()
  if (!trimmed) return undefined
  const exact = RUNTIME_CATALOG.find((entry) => catalogEntryCommandLine(entry) === trimmed)
  if (exact) return exact
  const tokens = trimmed.split(/\s+/)
  const first = basename(tokens[0])
  const direct = RUNTIME_CATALOG.find((entry) => entry.command === first || entry.detectCommand === first)
  if (direct) return direct
  return RUNTIME_CATALOG.find((entry) =>
    tokens.some((token) => {
      const name = basename(token)
      // `@agentclientprotocol/codex-acp` → `codex-acp`; `claude-code-acp`,
      // the older package's bin, still means Claude Code.
      return (
        name === entry.command ||
        name === entry.detectCommand ||
        (entry.id === 'claude-code' && name === 'claude-code-acp')
      )
    }),
  )
}

/** `C:\tools\codex.cmd` → `codex`; `@agentclientprotocol/codex-acp` → `codex-acp`. */
function basename(token: string): string {
  const last = token.split(/[\\/]/).pop() ?? token
  return last.replace(/\.(exe|cmd|bat|ps1)$/i, '')
}
