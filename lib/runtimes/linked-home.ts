// The linked-home identity strategy: one implementation for every CLI that
// relocates its home through an environment variable.
//
// `lib/runtimes/home.ts` predicted this: "Claude Code relocates its home with
// CLAUDE_CONFIG_DIR and Codex with CODEX_HOME, and both keep a skills/<name>/
// pool with the same shape. So the pattern generalises to a strategy per
// runtime rather than a rewrite." This is that strategy, parameterised by the
// catalog entry's `RuntimeHomeLayout` rather than written three times.
//
// What it does per run: an empty directory; a link to every entry of the
// real home except the skills pool and the layout's excluded entries (so
// config, credentials and caches are the live shared copies, exactly as the
// Hermes overlay treats them); a fresh skills directory holding links to
// ONLY the skills this agent has enabled; and the layout's environment
// variable pointing at the overlay. Torn down after the turn.
//
// What it does not do, stated rather than discovered: per-agent memory and
// per-conversation state. Hermes keeps those in files the overlay can
// re-point; Codex keeps session history in SQLite at its home root and
// Claude keeps transcripts under `projects/`. Those pass through (or are
// excluded) as the layout says, and every agent on that runtime shares
// them. A stricter isolation is a whole home per agent, which is a different
// strategy and a different cost, and nothing here pretends otherwise.
import { existsSync, type Dirent } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RuntimeCatalogEntry, RuntimeHomeLayout } from './catalog'
import { linkDir, linkFile, normalizeSkillNames } from './fs-links'
import type { RuntimeHomeRequest, RuntimeHomeResult, RuntimeHomeStrategy } from './home'

function defaultOverlayRoot(): string {
  return process.env.RUNTIME_HOME_OVERLAY_ROOT || join(tmpdir(), 'notionforge-runtime-homes')
}

/**
 * Where the CLI's real home is on this machine.
 *
 * The server's own environment wins when it names one — an operator who runs
 * Codex out of a non-default `CODEX_HOME` has already told us where it is —
 * otherwise the CLI's documented default under the user's home directory.
 * Read from `process.env` directly rather than through the spawn allowlist,
 * because this is our own lookup, not something handed to a child.
 */
export function resolveBaseHome(layout: RuntimeHomeLayout, env: Record<string, string | undefined> = process.env): string {
  const configured = env[layout.envVar]
  if (configured && configured.trim().length > 0) return resolve(configured)
  return resolve(join(homedir(), ...layout.defaultDir))
}

export interface LinkedHomeOverlay extends RuntimeHomeResult {
  /** The overlay directory, for tests and diagnostics. */
  homeDir: string
  /** The real home the overlay was built from. */
  baseHome: string
  hardlinkFallbackFor: string[]
}

export async function buildLinkedHome(
  layout: RuntimeHomeLayout,
  request: RuntimeHomeRequest & { overlayRoot?: string; baseHome?: string },
): Promise<LinkedHomeOverlay> {
  const baseHome = resolve(request.baseHome ?? resolveBaseHome(layout))
  const overlayRoot = resolve(request.overlayRoot ?? defaultOverlayRoot())
  const homeDir = join(overlayRoot, String(request.runId))
  const enabledSkills = normalizeSkillNames(request.enabledSkills)
  const hardlinkFallbackFor: string[] = []

  const cleanup = async () => {
    try {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (err) {
      // A CLI that still holds a file open for a moment after exit makes
      // Windows refuse the unlink. A leftover overlay is litter, not a failed
      // turn — the next run of the same id clears it first anyway.
      console.warn(`[runtime-home] could not fully remove overlay ${homeDir}; leaving it for later cleanup.`, err)
    }
  }

  // A CLI that has never been run on this machine has no home yet. That is a
  // sign-in problem, and the probe says so; here the honest answer is "no
  // relocation, every skill missing" rather than an overlay of nothing that
  // would hide the CLI's real config from it.
  if (!existsSync(baseHome)) {
    return {
      env: {},
      missingSkills: enabledSkills,
      cleanup: async () => {},
      homeDir,
      baseHome,
      hardlinkFallbackFor,
    }
  }

  await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  await mkdir(homeDir, { recursive: true })

  const excluded = new Set([layout.skillsDir, ...(layout.excludeEntries ?? [])])
  let entries: Dirent[]
  try {
    entries = await readdir(baseHome, { withFileTypes: true })
  } catch (err) {
    await cleanup()
    throw new Error(`${layout.envVar} base directory is not readable: ${baseHome}`, { cause: err })
  }

  for (const entry of entries) {
    if (excluded.has(entry.name)) continue
    const target = join(baseHome, entry.name)
    const dest = join(homeDir, entry.name)
    if (entry.isDirectory()) await linkDir(target, dest)
    else if (entry.isFile()) await linkFile(target, dest, hardlinkFallbackFor)
    // Sockets, FIFOs and existing links are skipped: none of them is config
    // a CLI reads on start, and linking a link is how cycles happen.
  }

  const skillsDir = join(homeDir, layout.skillsDir)
  await mkdir(skillsDir, { recursive: true })
  const baseSkillsDir = join(baseHome, layout.skillsDir)
  const missingSkills: string[] = []
  for (const name of enabledSkills) {
    const target = join(baseSkillsDir, name)
    if (!existsSync(target)) {
      missingSkills.push(name)
      continue
    }
    await linkDir(target, join(skillsDir, name))
  }

  return {
    env: { [layout.envVar]: homeDir },
    missingSkills,
    cleanup,
    homeDir,
    baseHome,
    hardlinkFallbackFor,
  }
}

/** A `RuntimeHomeStrategy` for one catalog entry that declares a home layout. */
export function createLinkedHomeStrategy(entry: RuntimeCatalogEntry): RuntimeHomeStrategy {
  const layout = entry.home
  if (!layout) throw new Error(`${entry.id} declares no home layout; it cannot have a linked-home strategy.`)
  return {
    id: entry.homeStrategy,
    label: `${entry.displayName} home (${layout.envVar})`,
    async materialise(request) {
      const overlay = await buildLinkedHome(layout, { ...request, baseHome: request.baseHome })
      return { env: overlay.env, missingSkills: overlay.missingSkills, cleanup: overlay.cleanup }
    },
  }
}
