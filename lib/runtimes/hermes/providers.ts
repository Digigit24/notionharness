// Phase C, Providers settings — reads/writes the AI-provider half of the
// real Hermes install on this machine (see `lib/hermes/personas.ts`'s own
// header comment for the sibling precedent this follows).
//
// SAFETY BOUNDARY, same discipline as personas.ts: `config.yaml` is a 550+
// line file carrying other real secrets elsewhere in it (e.g. `gateway.
// api_server.key`) — this module NEVER parses the whole file with a YAML
// library and NEVER returns/logs its raw content. It only ever touches the
// small `model:` block at the very top (`provider`/`default`/`base_url`)
// via a targeted regex, confirmed live against this exact file's format
// (LF line endings, 2-space indent, unquoted scalars — see the regex below).
// Every write makes a timestamped backup first, matching this install's own
// existing `config.yaml.bak.<timestamp>` convention (confirmed via its own
// directory listing) — not a new habit invented here.
//
// `.env`'s provider API keys are read the same narrow way: presence/length
// only, never the value itself, matching the same posture this session
// already used when diagnosing the Kimi outage by hand.
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveProfileHome } from './profiles'

function hermesHome(): string {
  const home = process.env.HERMES_HOME_BASE
  if (!home) throw new Error('HERMES_HOME_BASE is not configured.')
  return home
}

/** Known LLM providers this install's `provider_models_cache.json` has ever
 * cached a model list for — the cache file itself carries no secrets (just
 * provider names + model name lists + fetch timestamps), so it's read in
 * full. Providers not in this cache yet (never configured) are omitted, not
 * invented — the "Switch provider" UI can only ever offer a real, known one. */
export interface ProviderModelInfo {
  provider: string
  models: string[]
}

export async function listKnownProviders(profile?: string | null): Promise<ProviderModelInfo[]> {
  // Per-profile, because each profile directory carries its OWN
  // `provider_models_cache.json` — confirmed on this machine. Reading the
  // root's cache while editing a profile's config would offer models that
  // profile has never authenticated against.
  const cachePath = path.join(resolveProfileHome(profile), 'provider_models_cache.json')
  let raw: string
  try {
    raw = await fs.readFile(cachePath, 'utf-8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, { models?: string[] }>
    return Object.entries(parsed).map(([provider, entry]) => ({
      provider,
      models: Array.isArray(entry.models) ? entry.models : [],
    }))
  } catch {
    return []
  }
}

/** The `<PROVIDER>_API_KEY` env-var naming convention this Hermes install's
 * own `.env` already uses (confirmed live: `KIMI_API_KEY`, `XAI_API_KEY`).
 * Maps a provider name (as it appears in `provider_models_cache.json`,
 * e.g. "kimi-coding") to the env var prefix Hermes actually reads
 * ("KIMI") — the provider name's first hyphen-delimited segment,
 * uppercased. Good enough for every provider seen on this install; a
 * provider whose real env var doesn't follow this pattern would just show
 * as "not configured" here rather than silently guessing wrong. */
function envKeyNameForProvider(provider: string): string {
  const prefix = provider.split('-')[0].toUpperCase()
  return `${prefix}_API_KEY`
}

export interface ProviderKeyStatus {
  provider: string
  envKeyName: string
  configured: boolean
}

const ENV_KEY_LINE_RE = /^(#\s*)?([A-Z][A-Z0-9_]*_API_KEY)\s*=\s*(.*)$/
const ENV_KEY_NAME_RE = /^[A-Z][A-Z0-9_]*_API_KEY$/

export interface ProviderEnvSlot {
  envKeyName: string
  configured: boolean
}

/**
 * Every `<NAME>_API_KEY` slot Hermes's own `.env` on this machine already
 * knows about — commented-out template lines included, not just the
 * providers `provider_models_cache.json` happens to have cached a model
 * list for (that's what `listKnownProviders` above is limited to). This is
 * what makes "add a new provider" possible instead of only "switch among
 * providers already used before": every slot the install's own `.env`
 * documents is a real, valid key name to write to, never invented.
 */
export async function listProviderEnvSlots(): Promise<ProviderEnvSlot[]> {
  const envPath = path.join(hermesHome(), '.env')
  let raw: string
  try {
    raw = await fs.readFile(envPath, 'utf-8')
  } catch {
    return []
  }
  const allKeys = new Set<string>()
  const configuredKeys = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const match = ENV_KEY_LINE_RE.exec(line)
    if (!match) continue
    const [, commentPrefix, envKeyName, value] = match
    allKeys.add(envKeyName)
    if (!commentPrefix && value.trim().length > 0) configuredKeys.add(envKeyName)
  }
  return [...allKeys].sort().map((envKeyName) => ({ envKeyName, configured: configuredKeys.has(envKeyName) }))
}

/**
 * Sets (or replaces) one provider's API key in Hermes's `.env` — the actual
 * "connect a new provider" write path `listProviderEnvSlots`/the Providers
 * page needed. Same safety posture as `setActiveModelConfig` below: only
 * ever touches the one matching line (commented template line included —
 * uncommenting it in place), backs up `.env` first, and the key value is
 * never logged or echoed back by any caller of this function.
 */
export async function setProviderApiKey({ envKeyName, value }: { envKeyName: string; value: string }): Promise<void> {
  if (!ENV_KEY_NAME_RE.test(envKeyName)) throw new Error('Invalid provider key name.')
  if (/[\r\n]/.test(value)) throw new Error('Key value cannot contain a newline.')

  const envPath = path.join(hermesHome(), '.env')
  const raw = await fs.readFile(envPath, 'utf-8')

  const backupName = `.env.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`
  await fs.copyFile(envPath, path.join(hermesHome(), backupName))

  const lineRe = new RegExp(`^#?\\s*${envKeyName}\\s*=.*$`, 'm')
  const updated = lineRe.test(raw)
    ? raw.replace(lineRe, `${envKeyName}=${value}`)
    : `${raw}${raw.endsWith('\n') ? '' : '\n'}${envKeyName}=${value}\n`

  await fs.writeFile(envPath, updated, 'utf-8')
}

/** Blanks a provider's key (leaves the line present but empty) rather than
 * deleting it outright — matches this install's own template convention of
 * an always-present, possibly-empty `<NAME>_API_KEY=` line. */
export async function removeProviderApiKey(envKeyName: string): Promise<void> {
  await setProviderApiKey({ envKeyName, value: '' })
}

export async function listProviderKeyStatus(providers: string[]): Promise<ProviderKeyStatus[]> {
  const envPath = path.join(hermesHome(), '.env')
  let raw: string
  try {
    raw = await fs.readFile(envPath, 'utf-8')
  } catch {
    return providers.map((provider) => ({ provider, envKeyName: envKeyNameForProvider(provider), configured: false }))
  }
  const lines = raw.split(/\r?\n/)
  return providers.map((provider) => {
    const envKeyName = envKeyNameForProvider(provider)
    const line = lines.find((l) => l.startsWith(`${envKeyName}=`))
    const value = line ? line.slice(envKeyName.length + 1).trim() : ''
    return { provider, envKeyName, configured: value.length > 0 }
  })
}

export interface ActiveModelConfig {
  provider: string
  model: string
  baseUrl: string
}


/**
 * Locates the `model:` block and the scalar keys inside it.
 *
 * The previous version of this module matched the block with a single rigid
 * pattern — LF endings, `base_url` first and double-quoted, then `default`,
 * then `provider` — because that is exactly how the install root's file
 * happens to be written. Checked against all five real config files on this
 * machine, that pattern matches ONE of them:
 *
 *   root            LF    base_url ""            order: base_url, default, provider
 *   profiles/ritik  CRLF  base_url unquoted      order: base_url, default, provider
 *   digitech-ops    CRLF  base_url ''            order: provider, default, base_url
 *   sales           CRLF  base_url unquoted      block starts at line 429, not line 1
 *
 * It failed closed rather than corrupting anything, which was the right
 * instinct — but it meant model switching could never work for any profile.
 * This version varies on all four axes: line endings, quote style, key order,
 * and block position.
 */
const MODEL_BLOCK_RE = /^model:[ \t]*\n(?:[ \t]+.*\n?)*/m

interface ScalarLine {
  /** Byte offset of the line within the block. */
  start: number
  end: number
  indent: string
  /** `"` , `'` or '' — preserved so a rewrite doesn't restyle the file. */
  quote: string
  value: string
}

function findScalar(block: string, key: string): ScalarLine | null {
  const re = new RegExp(`^([ \t]+)${key}:[ \t]*(.*)$`, 'm')
  const m = re.exec(block)
  if (!m) return null
  const rawValue = m[2]
  const quoted = /^(["'])(.*)\1$/.exec(rawValue.trim())
  return {
    start: m.index,
    end: m.index + m[0].length,
    indent: m[1],
    quote: quoted ? quoted[1] : '',
    value: quoted ? quoted[2] : rawValue.trim(),
  }
}

export interface ModelConfigEdit {
  provider?: string
  model?: string
  baseUrl?: string
}

/** Reads the active provider/model for one profile (or the install root). */
export async function getActiveModelConfig(profile?: string | null): Promise<ActiveModelConfig | null> {
  const configPath = path.join(resolveProfileHome(profile), 'config.yaml')
  let rawFile: string
  try {
    rawFile = await fs.readFile(configPath, 'utf-8')
  } catch {
    return null
  }
  // See profiles.ts: `.` excludes \r in JS regex, so a CRLF file's block match
  // stops after its first line unless endings are normalised first.
  const raw = rawFile.replace(/\r\n/g, '\n')
  const block = MODEL_BLOCK_RE.exec(raw)?.[0]
  if (!block) return null
  return {
    provider: findScalar(block, 'provider')?.value ?? '',
    model: findScalar(block, 'default')?.value ?? '',
    baseUrl: findScalar(block, 'base_url')?.value ?? '',
  }
}

/**
 * Switches a profile's provider/model, touching only the specific scalar
 * lines named in `edit`.
 *
 * Every other byte of `config.yaml` is passed through unchanged — including
 * its original line endings, which matters because rewriting a CRLF file as
 * LF would show up as a whole-file diff in someone else's Hermes install.
 * Backs up first, matching this install's own `config.yaml.bak.<timestamp>`
 * convention.
 */
export async function setActiveModelConfig(
  edit: ModelConfigEdit,
  profile?: string | null,
): Promise<void> {
  const entries = Object.entries(edit).filter(([, v]) => typeof v === 'string') as Array<[string, string]>
  if (entries.length === 0) throw new Error('Nothing to change.')

  const home = resolveProfileHome(profile)
  const configPath = path.join(home, 'config.yaml')
  const original = await fs.readFile(configPath, 'utf-8')
  // Preserve whatever the file already uses rather than imposing one.
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const raw = original.replace(/\r\n/g, '\n')

  const blockMatch = MODEL_BLOCK_RE.exec(raw)
  if (!blockMatch) {
    throw new Error('Could not find a model: block in config.yaml — refusing to write blindly.')
  }
  let block = blockMatch[0]
  const blockIndent = /^([ \t]+)\S/m.exec(block)?.[1] ?? '  '

  const KEY_BY_FIELD: Record<string, string> = { provider: 'provider', model: 'default', baseUrl: 'base_url' }
  for (const [field, value] of entries) {
    const key = KEY_BY_FIELD[field]
    if (!key) continue
    const existing = findScalar(block, key)
    if (existing) {
      const quoted = existing.quote ? `${existing.quote}${value}${existing.quote}` : value
      // Re-quote an emptied value so the YAML stays valid.
      const rendered = value === '' && !existing.quote ? '""' : quoted
      block = block.slice(0, existing.start) + `${existing.indent}${key}: ${rendered}` + block.slice(existing.end)
    } else {
      // Key absent from this profile's block — append it with the block's own
      // indentation rather than skipping the edit silently.
      const suffix = block.endsWith('\n') ? '' : '\n'
      block = `${block}${suffix}${blockIndent}${key}: ${value === '' ? '""' : value}\n`
    }
  }

  const updatedLf = raw.slice(0, blockMatch.index) + block + raw.slice(blockMatch.index + blockMatch[0].length)
  const updated = eol === '\r\n' ? updatedLf.replace(/\n/g, '\r\n') : updatedLf

  const backupName = `config.yaml.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`
  await fs.copyFile(configPath, path.join(home, backupName))
  await fs.writeFile(configPath, updated, 'utf-8')
}
