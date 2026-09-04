// Hermes profiles — discovery and path resolution.
//
// A Hermes "profile" is not a config section; it is a complete alternate
// HERMES_HOME. Verified on this machine: `<hermes>/profiles/<name>` carries
// its own `config.yaml`, `auth.json`, `SOUL.md`, `skills/`, `memories/`,
// `state.db` and `provider_models_cache.json` — everything the install root
// has. That single fact is what makes per-agent models possible without any
// CLI flag: point HERMES_HOME at a profile and Hermes uses that profile's
// model, credentials and persona.
//
// SAFETY BOUNDARY, inherited from `providers.ts` and `personas.ts`: a
// profile's `config.yaml` is a large file carrying unrelated secrets (e.g.
// `gateway.api_server.key`). Nothing here parses it whole, returns it, or
// logs it — reads are narrow and targeted, exactly as the sibling modules
// already established.
import fs from 'node:fs/promises'
import path from 'node:path'

/** Hermes's own validation for a profile name, mirrored so the UI rejects a
 * bad name before the filesystem does — and, more importantly, so a name
 * from the database can never be interpolated into a path unchecked. */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name)
}

export function hermesRoot(): string {
  const home = process.env.HERMES_HOME_BASE
  if (!home) throw new Error('HERMES_HOME_BASE is not configured.')
  return home
}

/**
 * Absolute path to a profile's home, or the install root when no profile is
 * named. The name is validated rather than trusted: it reaches here from a
 * database column that a form writes, and it is about to become a filesystem
 * path, so a `../..` would otherwise walk straight out of the Hermes install.
 */
export function resolveProfileHome(profile?: string | null): string {
  const root = hermesRoot()
  if (!profile) return root
  if (!isValidProfileName(profile)) {
    throw new Error(
      `Invalid Hermes profile name ${JSON.stringify(profile)} — expected lowercase letters, digits, "-" or "_".`,
    )
  }
  return path.join(root, 'profiles', profile)
}

export interface HermesProfileSummary {
  name: string
  /** Absolute path to the profile's HERMES_HOME. */
  homeDir: string
  /** Active provider from that profile's own `config.yaml`, when readable. */
  provider: string | null
  /** Active model from that profile's own `config.yaml`, when readable. */
  model: string | null
  /** False when the directory exists but isn't a usable home (no config.yaml). */
  usable: boolean
}

/** Matches only the small `model:` block at the top of `config.yaml` — the
 * same targeted regex approach `providers.ts` already uses and documents,
 * never a whole-file YAML parse. */
const MODEL_BLOCK_RE = /^model:\s*\n(?:[ \t]+.*\n?)*/m

async function readModelBlock(homeDir: string): Promise<{ provider: string | null; model: string | null }> {
  try {
    const rawFile = await fs.readFile(path.join(homeDir, 'config.yaml'), 'utf-8')
    // Normalise line endings before matching. In JavaScript, `.` treats \r as
    // a line terminator and excludes it, so on a CRLF file `[ \t]+.*\n?`
    // consumes a line's text, then fails on the \r, and the block match stops
    // dead after its FIRST line. Not hypothetical: this install's root
    // config.yaml is LF and every profile's is CRLF, so this reported "no
    // model configured" for all four real profiles while working at the root.
    // Normalising is safe for a READ; a write must preserve the file's own
    // endings rather than silently rewriting CRLF as LF.
    const raw = rawFile.replace(/\r\n/g, '\n')
    const block = MODEL_BLOCK_RE.exec(raw)?.[0] ?? ''
    const provider = /^\s+provider:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? null
    const model = /^\s+default:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? null
    const unquote = (v: string | null) => (v == null ? null : v.replace(/^["']|["']$/g, '').trim() || null)
    return { provider: unquote(provider), model: unquote(model) }
  } catch {
    return { provider: null, model: null }
  }
}

/**
 * Every profile this Hermes install actually has, plus the install root
 * itself presented as the implicit default.
 *
 * The root is included as a first-class entry (name `''`) because "no
 * profile" is a real, valid choice an agent can make — it is what every
 * existing agent does today — and a picker that omitted it would have no way
 * to express going back to the default.
 */
export async function listHermesProfiles(): Promise<HermesProfileSummary[]> {
  const root = hermesRoot()
  const rootConfig = await readModelBlock(root)
  const out: HermesProfileSummary[] = [
    { name: '', homeDir: root, provider: rootConfig.provider, model: rootConfig.model, usable: true },
  ]

  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await fs.readdir(path.join(root, 'profiles'), { withFileTypes: true })
  } catch {
    // No `profiles/` directory at all is a perfectly normal Hermes install.
    return out
  }

  const named = entries.filter((entry) => entry.isDirectory() && isValidProfileName(entry.name))
  const summaries = await Promise.all(
    named.map(async (entry) => {
      const homeDir = path.join(root, 'profiles', entry.name)
      const config = await readModelBlock(homeDir)
      let usable = true
      try {
        await fs.access(path.join(homeDir, 'config.yaml'))
      } catch {
        usable = false
      }
      return { name: entry.name, homeDir, provider: config.provider, model: config.model, usable }
    }),
  )

  summaries.sort((a, b) => a.name.localeCompare(b.name))
  out.push(...summaries)
  return out
}

/** One profile's summary, or null when it doesn't exist on disk. */
export async function getHermesProfile(profile: string | null | undefined): Promise<HermesProfileSummary | null> {
  const all = await listHermesProfiles()
  return all.find((entry) => entry.name === (profile ?? '')) ?? null
}
