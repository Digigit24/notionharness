// R14-P0.6 — a static, hand-maintained list of known runtime *kinds*, for the
// "+ Add runtimes" picker (`components/runtimes/runtime-catalog-picker.tsx`).
//
// D2 STILL GOVERNS. This file describes how to REACH a runtime — a command,
// its arguments, and which ACP adapter (if any) stands between us and the
// real CLI. It asserts NOTHING about what that runtime can do. Capability
// claims (can it resume a session, does it offer model selection, what
// config options does it expose) come only from that runtime's own ACP
// `initialize`/`session/new` handshake, stored verbatim on the profile after
// a real probe (`lib/runtimes/detect.ts`, `probeAcpRuntime`). A catalog entry
// below is a pre-filled guess at a command line, nothing more — picking one
// does not tell the app anything the agent has not said about itself yet.
//
// HONESTY ABOUT WHICH ENTRIES ARE REAL. AGENTS.md records a real, live
// investigation of three of these: Hermes speaks ACP natively (already the
// only thing this app has run in anger — see `lib/hermes/acp-client.ts`);
// Claude Code 2.1.259 and Codex 0.144.4 were both installed and inspected on
// the dev machine and neither speaks ACP directly — Claude Code speaks the
// Agent SDK's stream-json protocol and Codex speaks its own `app-server`
// JSON-RPC. Zed publishes ACP adapters for both
// (`@zed-industries/claude-agent-acp`, `zed-industries/codex-acp`), and a
// runtime profile for either one is supposed to point at that adapter binary,
// not at the raw `claude`/`codex` CLI. Those three entries are marked
// `commandConfidence: 'documented'` below, but even "documented" is not the
// same as "probed on this machine" — nobody here has confirmed the exact bin
// name an `npm install -g` of those adapter packages leaves on PATH, only
// that the packages exist and are the right shape. That is exactly what the
// probe step after adding a profile is for.
//
// The remaining entries (Gemini, OpenCode, Goose) are named only because
// D1/R10.2b of `docs/ROADMAP-SERIES.md` already name them as plausible
// ACP-speaking CLIs worth listing — AionUi supports all three. Nobody has
// installed or inspected any of them from this codebase. Their `command`
// values are illustrative placeholders (`commandConfidence: 'illustrative'`)
// and are honestly likely wrong. Inventing a *confident-looking* wrong
// command for a CLI nobody has verified would silently break someone's setup
// attempt the first time they clicked "Add" and it failed for a reason that
// had nothing to do with their machine — so the picker UI must show the
// `commandConfidence` distinction rather than paper over it.
//
// BADGE HONESTY (the "Ready" vs "CLI needed" column). Determining whether a
// given command is actually resolvable on THIS machine's PATH means running
// `resolveCommandPath` (`lib/runtimes/spawn-command.ts`), which spawns a real
// `where`/`which` child process. Doing that for every catalog entry on every
// render of this picker — a handful of processes spawned just to draw a list
// — is exactly what D0 forbids ("no blocking a first render on an external
// process", and more generally no query/process cost that scales with a
// static list on every page load). So this file computes NO status at all.
// The picker instead cross-references the workspace's EXISTING runtime
// profiles (already fetched by the settings page, already probed through the
// one real probe path, `probeAcpRuntime`) by command name: a catalog entry
// whose command matches an existing profile that last probed `ok` is
// "Ready"; everything else — including every entry nobody has added yet —
// defaults honestly to "CLI needed — probe after adding". No new detection
// path, no fabricated status.
import type { LucideIcon } from 'lucide-react'
import { Bird, Bot, Gem, Sparkles, SquareTerminal, Code2 } from 'lucide-react'
import type { RuntimeProfile } from '@/payload-types'

export interface RuntimeCatalogEntry {
  /** Stable id for this catalog row. Not written anywhere — it only has to be
   * unique within this file and is used to key the picker's list. */
  id: string
  displayName: string
  icon: LucideIcon
  description: string
  /** `AddRuntimeProfileForm`'s existing protocol-family select. */
  protocolFamily: RuntimeProfile['protocolFamily']
  /** Mirrors `collections/RuntimeProfiles.ts`'s `homeStrategy` field. Not
   * currently written by `createRuntimeProfile` (it only accepts name,
   * protocolFamily and commandName today) — carried here so the picker can
   * show it as a hint in the detail pane, and so a future extension of the
   * create action has a real value to reach for instead of guessing. */
  homeStrategy: 'hermes' | 'none'
  /** The executable `spawn` should run. */
  command: string
  /** Fixed arguments after the command, if any. Kept separate from `command`
   * for display in the detail pane; `AddRuntimeProfileForm` folds these back
   * into ONE string before calling `createRuntimeProfile` (which has no
   * separate args parameter), using the same "one string, split at spawn
   * time" convention `lib/runtimes/spawn-command.ts`'s `splitCommand` already
   * relies on elsewhere in this app. */
  args: string[]
  /** How sure we are this command shape is real, see the file header. Shown
   * in the detail pane so nobody mistakes a guess for a verified fact. */
  commandConfidence: 'documented' | 'illustrative'
  /** One sentence naming where `command`/`args` came from, for the detail
   * pane's "Source" line. */
  source: string
}

export const RUNTIME_CATALOG: RuntimeCatalogEntry[] = [
  {
    id: 'hermes',
    displayName: 'Hermes',
    icon: Sparkles,
    description:
      "The Hermes agent this install already runs turns through — the only runtime this app has driven end to end. Speaks ACP natively; no adapter needed.",
    protocolFamily: 'acp',
    homeStrategy: 'hermes',
    command: 'hermes-acp',
    args: [],
    commandConfidence: 'documented',
    source:
      'lib/hermes/acp-client.ts spawns this exact binary today, confirmed working via `hermes-acp --check` (see AGENTS.md).',
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    icon: Bot,
    description:
      "Claude Code, reached through Zed's ACP adapter. Claude Code itself speaks the Agent SDK's stream-json protocol, not ACP — this app can only drive it through the adapter, never the raw `claude` CLI.",
    protocolFamily: 'acp',
    homeStrategy: 'none',
    command: 'claude-agent-acp',
    args: [],
    commandConfidence: 'documented',
    source:
      "Zed's published adapter package, @zed-industries/claude-agent-acp (installed and inspected on the dev machine per AGENTS.md — Claude Code 2.1.259 confirmed to speak stream-json, not ACP). The exact bin name left on PATH by a global npm install has not been independently reprobed here.",
  },
  {
    id: 'codex',
    displayName: 'Codex',
    icon: SquareTerminal,
    description:
      "OpenAI Codex, reached through Zed's ACP adapter. Codex speaks its own app-server JSON-RPC protocol, not ACP — same shape as Claude Code above, different vendor.",
    protocolFamily: 'acp',
    homeStrategy: 'none',
    command: 'codex-acp',
    args: [],
    commandConfidence: 'documented',
    source:
      "Zed's published adapter package, zed-industries/codex-acp (Codex 0.144.4 installed and inspected on the dev machine per AGENTS.md — confirmed to speak app-server JSON-RPC, not ACP). The exact bin name left on PATH by a global install has not been independently reprobed here.",
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    icon: Gem,
    description:
      'Illustrative placeholder. Named in this app\'s own roadmap (D1, R10.2b of docs/ROADMAP-SERIES.md) as a plausible ACP-speaking CLI, alongside the others AionUi already supports — nobody has installed, inspected or probed it from this codebase. Confirm the real invocation before trusting this entry.',
    protocolFamily: 'acp',
    homeStrategy: 'none',
    command: 'gemini',
    args: [],
    commandConfidence: 'illustrative',
    source:
      'Unverified guess. `docs/ROADMAP-SERIES.md` names `gemini` as a command worth scanning for, nothing more — no adapter or native-ACP claim has been checked.',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    icon: Code2,
    description:
      'Illustrative placeholder, same caveat as Gemini above — named in the roadmap as a plausible entry, never installed or probed here.',
    protocolFamily: 'acp',
    homeStrategy: 'none',
    command: 'opencode',
    args: [],
    commandConfidence: 'illustrative',
    source: 'Unverified guess, named only in docs/ROADMAP-SERIES.md\'s D1 list of runtimes AionUi already supports.',
  },
  {
    id: 'goose',
    displayName: 'Goose',
    icon: Bird,
    description:
      "Illustrative placeholder for Block's Goose agent, same caveat as the two above — named only because AionUi supports it; never installed or probed from this codebase.",
    protocolFamily: 'acp',
    homeStrategy: 'none',
    command: 'goose',
    args: [],
    commandConfidence: 'illustrative',
    source: 'Unverified guess, named only in docs/ROADMAP-SERIES.md\'s D1 list of runtimes AionUi already supports.',
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
 * workspace's EXISTING runtime profiles whose last probe came back `ok`
 * (build it once from data the settings page already fetched, e.g.
 * `profiles.filter(p => p.lastProbeCode === 'ok').map(p => p.commandName)`).
 */
export function isCatalogEntryReady(entry: RuntimeCatalogEntry, probedCommandLines: ReadonlySet<string>): boolean {
  return probedCommandLines.has(catalogEntryCommandLine(entry))
}
