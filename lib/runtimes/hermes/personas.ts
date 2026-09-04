// Phase C, C2 — "Personalities: SOUL.md plus /personality — a card per
// persona with a live preview and one-click switch." Reads REAL data from
// this machine's actual Hermes install (see AGENTS.md's Phase C notes:
// this is the user's live WhatsApp business assistant, not a dev fixture)
// — a per-sender `identities/*.md` persona layer, and full `profiles/*`
// workspaces each with their own SOUL.md, one of which is "active" via a
// plain `active_profile` text file that Hermes itself reads to route any
// WhatsApp sender not otherwise matched in `sender-routing.json`.
//
// Scoped deliberately narrow: only ever reads `SOUL.md`/`identities/*.md`
// content (persona/prompt text) and the `active_profile` marker — never
// `auth.json`, `config.yaml`, or anything else under a profile directory,
// since those carry real credentials (`config.yaml`'s own `gateway.
// api_server.key`, confirmed during this session's Hermes-reachability
// investigation, is exactly the kind of value this module must never
// surface). `setActiveHermesProfile` only ever writes a name it already
// found on disk via `listHermesProfiles` first — never an arbitrary
// caller-supplied string — so it can't be used to write anything but one
// of the real, existing profile names into `active_profile`'s one line.

import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

function hermesHome(): string {
  const home = process.env.HERMES_HOME_BASE
  if (!home) throw new Error('HERMES_HOME_BASE is not configured.')
  return home
}

export interface HermesPersonaFile {
  /** Filename without extension — the stable identifier. */
  slug: string
  title: string
  preview: string
  content: string
}

async function readPersonaFile(filePath: string, slug: string): Promise<HermesPersonaFile | null> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  const lines = content.split(/\r?\n/)
  const titleLine = lines.find((l) => l.trim().startsWith('#'))
  const title = titleLine ? titleLine.replace(/^#+\s*/, '').trim() : slug
  const preview = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .slice(0, 2)
    .join(' ')
    .slice(0, 220)
  return { slug, title, preview, content }
}

/** Per-sender identity overrides — `identities/*.md`, excluding its own README. */
export async function listHermesIdentities(): Promise<HermesPersonaFile[]> {
  const dir = path.join(hermesHome(), 'identities')
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const files = entries.filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md')
  const results = await Promise.all(
    files.map((f) => readPersonaFile(path.join(dir, f), path.basename(f, path.extname(f)))),
  )
  return results.filter((r): r is HermesPersonaFile => r !== null)
}

export interface HermesProfileSummary {
  name: string
  soul: HermesPersonaFile | null
}

/** Full profile workspaces — `profiles/<name>/SOUL.md`. */
export async function listHermesProfiles(): Promise<HermesProfileSummary[]> {
  const profilesDir = path.join(hermesHome(), 'profiles')
  let entries: Dirent[]
  try {
    entries = await fs.readdir(profilesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries.filter((e) => e.isDirectory())
  return Promise.all(
    dirs.map(async (dir) => ({
      name: dir.name,
      soul: await readPersonaFile(path.join(profilesDir, dir.name, 'SOUL.md'), dir.name),
    })),
  )
}

export async function getActiveHermesProfile(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(hermesHome(), 'active_profile'), 'utf-8')
    return raw.trim() || null
  } catch {
    return null
  }
}

/**
 * Switches the installation's active Hermes profile — a real, live change
 * to which persona/workspace answers any WhatsApp sender not otherwise
 * routed by `sender-routing.json`. Validates `profileName` against the
 * real directory listing before writing anything.
 */
export async function setActiveHermesProfile(profileName: string): Promise<void> {
  const profiles = await listHermesProfiles()
  if (!profiles.some((p) => p.name === profileName)) {
    throw new Error(`Unknown Hermes profile: ${profileName}`)
  }
  await fs.writeFile(path.join(hermesHome(), 'active_profile'), `${profileName}\n`, 'utf-8')
}
