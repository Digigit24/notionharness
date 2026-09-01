// ROADMAP P3.4 — "D2 in practice": per-agent Hermes identity via a
// HERMES_HOME overlay, built fresh for every run and torn down after.
//
// The real, shared Hermes install on a host (confirmed by inspecting one:
// `config.yaml`, `auth.json`, model/cost caches, `cron/`, `gateway*`, etc.)
// is one big directory tree the `hermes-acp` binary reads as `$HERMES_HOME`.
// Pointing every agent's run straight at that shared directory would mean
// every agent sees every other agent's skills — the opposite of "each agent
// gets its own Hermes profile." This module builds a disposable overlay
// directory per run that:
//   - passes almost everything from the shared base through unchanged
//     (config, auth, model caches, cron — none of that is agent-specific)
//   - replaces `skills/` with a fresh directory containing links to ONLY
//     the skill names this specific agent has enabled — the actual identity
//     boundary the roadmap is asking for
//   - replaces `memories/` with a link out to a *persistent, per-agent*
//     store (so memory survives this disposable directory being deleted,
//     and is shared across every run of the same agent — not per-run)
//   - replaces `state.db` with a link out to a *persistent, per-conversation*
//     store (sharded by conversation, not by agent or by run: tasks within
//     one conversation execute serially — see the daemon's task-board
//     model — so a conversation-scoped shard always has exactly one writer,
//     and two unrelated tasks never contend for the same SQLite file)
//
// Windows note (confirmed on this host, not assumed): creating a directory
// symlink or a file symlink both fail with "Administrator privilege
// required" without Developer Mode / elevation, but a directory **junction**
// and a file **hardlink** both succeed unprivileged. So directories use
// junctions and files fall back to a hardlink when a real symlink isn't
// permitted — logged in the result (`hardlinkFallbackFor`), never silently
// swapped in without a trace. `cleanup()` only ever removes the overlay
// directory's own reparse points/link entries, never what they point at —
// verified empirically (`fs.rm(overlayDir, { recursive: true })` does not
// follow a junction into its target on this platform).
//
// Also confirmed empirically: Windows junctions silently misbehave with a
// *relative* target (unlike POSIX symlinks, which resolve relative to the
// link's own directory just fine). Every path this module links to is
// resolved to absolute before use — the built-in defaults already are
// (`os.homedir()`/`os.tmpdir()` are always absolute), but a caller-supplied
// override is not guaranteed to be, so `path.resolve()` runs unconditionally
// rather than trusting the input.
import { existsSync, type Dirent } from 'node:fs'
import { link, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface BuildHermesHomeOverlayOptions {
  /** Stable identifier for this run — the overlay directory's own name. */
  runId: string
  /** The agent whose identity this run is executing under. */
  agentId: string | number
  /** The conversation this run belongs to — the state.db shard key. */
  conversationId: string | number
  /** Raw `Agents.skills` JSON value — normalized defensively, see below. */
  enabledSkills: unknown
  /** The shared, real Hermes install this overlay is built on top of. */
  baseHermesHome?: string
  /** Root directory holding one persistent memories/ store per agent. */
  agentMemoryRoot?: string
  /** Root directory holding one persistent state.db per conversation. */
  conversationStateRoot?: string
  /** Root directory for disposable per-run overlay directories. */
  taskRoot?: string
}

export interface HermesHomeOverlay {
  /** Pass as `env.HERMES_HOME` to `sendTurn`/the spawned binary. */
  homeDir: string
  /** The persistent per-agent directory this run's memories/ resolves to. */
  memoriesDir: string
  /** The persistent per-conversation file this run's state.db resolves to. */
  stateDbPath: string
  /** Enabled skill names that don't exist in the base skills pool — surfaced, not silently dropped. */
  missingSkills: string[]
  /** Paths where a hardlink substituted for an unavailable real file symlink (see module comment). */
  hardlinkFallbackFor: string[]
  /** Removes the disposable overlay directory only — never the persistent targets above. */
  cleanup: () => Promise<void>
}

// Rarely needs overriding — matches this project's own precedent in
// `scripts/hermes-acp-smoke.ts` (a hardcoded default reflecting verified
// machine state, overridable via env for other hosts/CI).
const DEFAULT_BASE_HERMES_HOME = 'C:\\Users\\hrith\\AppData\\Local\\hermes'

const IDENTITY_SCOPED_ENTRIES = new Set(['skills', 'memories', 'state.db'])

function defaultAgentMemoryRoot(): string {
  return process.env.HERMES_AGENT_MEMORY_ROOT || join(homedir(), '.notionforge', 'hermes', 'agent-memories')
}

function defaultConversationStateRoot(): string {
  return process.env.HERMES_CONVERSATION_STATE_ROOT || join(homedir(), '.notionforge', 'hermes', 'conversation-state')
}

function defaultTaskRoot(): string {
  return process.env.HERMES_TASK_ROOT || join(tmpdir(), 'notionforge-hermes-runs')
}

// `Agents.skills` is an untyped Payload `json` field (defaultValue `[]`) —
// accept whatever shape it turns out to hold rather than assuming. The real
// on-disk skill pool is one subdirectory per skill name (confirmed:
// `skills/devops/`, `skills/email/`, etc.), so a bare string name is the
// only shape actually usable here.
function normalizeSkillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry)
    else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name)
    }
  }
  return names
}

async function linkDir(target: string, dest: string): Promise<void> {
  await symlink(target, dest, process.platform === 'win32' ? 'junction' : 'dir')
}

async function linkFile(target: string, dest: string, hardlinkFallbackFor: string[]): Promise<void> {
  try {
    await symlink(target, dest, 'file')
  } catch {
    // See module comment: unprivileged Windows can't make file symlinks but
    // can make hardlinks. A hardlink behaves identically for in-place writes
    // (how SQLite normally journals) but — unlike a symlink — would go stale
    // if the target were ever replaced via delete-and-recreate rather than
    // written in place. Recorded, not hidden.
    await link(target, dest)
    hardlinkFallbackFor.push(dest)
  }
}

export async function buildHermesHomeOverlay(opts: BuildHermesHomeOverlayOptions): Promise<HermesHomeOverlay> {
  const baseHermesHome = resolve(opts.baseHermesHome ?? process.env.HERMES_HOME_BASE ?? DEFAULT_BASE_HERMES_HOME)
  const agentMemoryRoot = resolve(opts.agentMemoryRoot ?? defaultAgentMemoryRoot())
  const conversationStateRoot = resolve(opts.conversationStateRoot ?? defaultConversationStateRoot())
  const taskRoot = resolve(opts.taskRoot ?? defaultTaskRoot())

  const homeDir = join(taskRoot, opts.runId)
  await mkdir(homeDir, { recursive: true })

  const hardlinkFallbackFor: string[] = []

  let baseEntries: Dirent[]
  try {
    baseEntries = await readdir(baseHermesHome, { withFileTypes: true })
  } catch (err) {
    throw new Error(`HERMES_HOME base directory not found or unreadable: ${baseHermesHome}`, { cause: err })
  }

  // Passthrough: everything the shared install has except the three
  // identity-scoped paths below — config/auth/caches/cron are not
  // agent-specific, every run reads the same live copy.
  for (const entry of baseEntries) {
    if (IDENTITY_SCOPED_ENTRIES.has(entry.name)) continue
    const target = join(baseHermesHome, entry.name)
    const dest = join(homeDir, entry.name)
    if (entry.isDirectory()) {
      await linkDir(target, dest)
    } else {
      await linkFile(target, dest, hardlinkFallbackFor)
    }
  }

  // skills/ — the actual per-agent identity boundary. A fresh directory
  // containing only this agent's enabled skills, each linked in from the
  // shared pool — never the whole shared skills/ directory wholesale.
  const skillsDir = join(homeDir, 'skills')
  await mkdir(skillsDir, { recursive: true })
  const baseSkillsDir = join(baseHermesHome, 'skills')
  const enabledSkillNames = normalizeSkillNames(opts.enabledSkills)
  const missingSkills: string[] = []
  for (const name of enabledSkillNames) {
    const target = join(baseSkillsDir, name)
    if (!existsSync(target)) {
      missingSkills.push(name)
      continue
    }
    await linkDir(target, join(skillsDir, name))
  }

  // memories/ — persistent per-AGENT store, so memory outlives this
  // disposable directory and is shared across every run of this agent. This
  // sharing is exactly why two concurrent runs of the same agent are
  // last-writer-wins on memory (roadmap 3.4's own accepted limitation —
  // surfaced in `components/agents/agent-editor.tsx`'s max-concurrent-runs
  // warning, not hidden): both runs' `memories/` links resolve to this
  // identical directory, and Hermes rewrites its memory files whole rather
  // than appending.
  const memoriesDir = join(agentMemoryRoot, String(opts.agentId))
  await mkdir(memoriesDir, { recursive: true })
  await linkDir(memoriesDir, join(homeDir, 'memories'))

  // state.db — persistent per-CONVERSATION store (not per-agent, not
  // per-run). Sharding here, specifically, is what guarantees a single
  // writer: tasks within one conversation run serially, so a
  // conversation's shard never has two concurrent runs touching it, unlike
  // memories/ above.
  const conversationDir = join(conversationStateRoot, String(opts.conversationId))
  await mkdir(conversationDir, { recursive: true })
  const stateDbPath = join(conversationDir, 'state.db')
  if (!existsSync(stateDbPath)) {
    // Touch: the hardlink fallback path requires the target to already
    // exist (a real symlink wouldn't need this, but must work identically
    // either way).
    await writeFile(stateDbPath, '')
  }
  await linkFile(stateDbPath, join(homeDir, 'state.db'), hardlinkFallbackFor)

  return {
    homeDir,
    memoriesDir,
    stateDbPath,
    missingSkills,
    hardlinkFallbackFor,
    cleanup: async () => {
      // Best-effort, never throws: confirmed live (dispatcher-wiring task,
      // real hermes-acp binary) that a passthrough hardlink like
      // `.mcp-discovery.lock` can still be held open by the OS for a brief
      // moment after the agent process exits, and Windows (unlike POSIX)
      // refuses to unlink an open file — `EBUSY`. `maxRetries`/`retryDelay`
      // ride out that transient window; if cleanup still can't fully
      // finish, it's logged and swallowed rather than thrown, because a
      // disposable directory failing to delete immediately must never turn
      // an otherwise-successful turn into a reported failure.
      try {
        await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (err) {
        console.warn(`[hermes] Failed to fully clean up overlay directory ${homeDir} (leaving it for later GC).`, err)
      }
    },
  }
}
