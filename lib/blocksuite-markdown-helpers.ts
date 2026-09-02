// ROADMAP B8.3 (Batch B-6 "Finish") — module splitting. Extracted from
// `lib/blocksuite-doc.ts` (one of the four oversized modules the plan named),
// specifically the pure, stateless markdown-formatting helpers `docToMarkdown`
// (still in `blocksuite-doc.ts`) calls throughout its block-serialization
// walker. None of these functions touch BlockSuite's `Doc`/`DocCollection`,
// register a schema, or have any module-load-order dependency — they're
// plain string/value transforms, which is exactly what made this split safe
// to do without deep BlockSuite-internals verification (the risk this
// batch's own instructions call out for the other three named files). The
// export surface `blocksuite-doc.ts` presented before this split is kept
// intact via re-exports there, so nothing importing from `@/lib/blocksuite-doc`
// needs to change.
//
// `AnyBlockModel` stays defined in `blocksuite-doc.ts` (it's used throughout
// that file's own doc-walking code, well beyond what moved here) and is
// imported here as a type-only import — safe against circularity since a
// type-only import is erased at compile time and creates no runtime edge
// between the two modules.
import type { AnyBlockModel } from './blocksuite-doc'

/** Cap on the number of table rows written into a document export, to keep the
 * markdown from growing unboundedly with a large Teable table. */
export const MAX_EXPORT_ROWS = 100

/** A resolved snapshot of a connected Teable table, shaped for markdown export. */
export interface TeableDatabaseSnapshot {
  /** Table name (from the connection record) — shown above the exported table. */
  title: string
  fields: { id: string; name: string; type: string; options?: { choices?: { id?: string; name: string }[] } }[]
  records: { id: string; fields: Record<string, unknown> }[]
  /** True when records were capped at MAX_EXPORT_ROWS. */
  truncated: boolean
}

/**
 * Resolves a `teable-databases` Payload record id to a {@link TeableDatabaseSnapshot}.
 * Return `null` to fall back to the placeholder (unconnected, unconfigured, or a
 * fetch failure must never break the whole export).
 */
export type DatabaseResolver = (teableDatabaseId: number) => Promise<TeableDatabaseSnapshot | null>

/** Marks a cell value as readable plain text for a markdown table cell. */
function formatCellValue(
  field: { type: string; options?: { choices?: { id?: string; name: string }[] } },
  value: unknown,
): string {
  if (value === null || value === undefined) return ''
  switch (field.type) {
    case 'checkbox':
      return value ? '✓' : '✗'
    case 'multipleSelect':
      return Array.isArray(value) ? value.map((v) => String(v)).join(', ') : String(value)
    case 'singleSelect':
      return String(value)
    case 'date': {
      const s = typeof value === 'string' ? value : String(value)
      const day = s.match(/^(\d{4}-\d{2}-\d{2})/)
      return day ? day[1] : s
    }
    case 'user': {
      if (Array.isArray(value)) {
        return value
          .map((u) => (u && typeof u === 'object' && 'name' in u && (u as { name?: unknown }).name ? String((u as { name: unknown }).name) : ''))
          .filter(Boolean)
          .join(', ')
      }
      if (value && typeof value === 'object' && 'name' in value) return String((value as { name: unknown }).name)
      return String(value)
    }
    default:
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (Array.isArray(value)) return value.map((v) => String(v)).join(', ')
      if (value && typeof value === 'object') {
        // Teable link/rollup cell values are plain objects that typically carry a
        // human-readable `title`/`text` alongside internal ids — surface that
        // rather than dumping raw JSON into the document.
        const obj = value as Record<string, unknown>
        if (typeof obj.title === 'string' && obj.title) return obj.title
        if (typeof obj.text === 'string' && obj.text) return obj.text
        if (typeof obj.name === 'string' && obj.name) return obj.name
        return JSON.stringify(value)
      }
      return String(value)
  }
}

/** Escapes a value so it is safe to place inside a GFM table cell. */
export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** Reads a string prop off a block model, normalizing non-strings and empty values to ''. */
export function propStr(model: AnyBlockModel, key: string, fallback = ''): string {
  const v = model[key]
  return typeof v === 'string' && v ? v : fallback
}

/**
 * Flattens a block's `Text` to a plain string, same as `.toString()`, except a
 * `mention` delta (whose `insert` is a lone placeholder character, not the
 * person's name) is rendered as `@Name` instead of silently vanishing — the
 * same "never let content disappear on export" standard applied elsewhere in
 * this file (bookmarks, embeds, attachments, etc.).
 */
export function textToString(text: { toDelta?(): { insert?: string; attributes?: Record<string, unknown> }[]; toString(): string } | undefined): string {
  if (!text) return ''
  if (typeof text.toDelta !== 'function') return text.toString()
  return text
    .toDelta()
    .map((op) => {
      const mention = op.attributes?.mention as { name?: unknown } | undefined
      if (mention && typeof mention.name === 'string') return `@${mention.name}`
      return op.insert ?? ''
    })
    .join('')
}

/** Renders a readable size suffix for attachment/file sizes. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes === 0) return ''
  if (bytes < 1024) return ` (${bytes} B)`
  if (bytes < 1024 * 1024) return ` (${(bytes / 1024).toFixed(1)} KB)`
  return ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`
}

/** A markdown link with a graceful fallback if the model has no URL. */
export function embedLink(model: AnyBlockModel, defaultLabel: string): string {
  const url = propStr(model, 'url')
  const label = propStr(model, 'title') || propStr(model, 'caption') || url || defaultLabel
  if (url) return `[${escapeTableCell(label)}](${url})`
  return `[${defaultLabel}${label !== defaultLabel ? `: ${escapeTableCell(label)}` : ''}]`
}

/** Renders a {@link TeableDatabaseSnapshot} as a GitHub-Flavored-Markdown table. */
export function snapshotToMarkdownTable(snapshot: TeableDatabaseSnapshot): string {
  if (!snapshot.fields.length || !snapshot.records.length) {
    const header = snapshot.fields.map((f) => escapeTableCell(f.name)).join(' | ')
    const separators = snapshot.fields.map(() => '---').join(' | ')
    return `| ${header} |\n| ${separators} |`
  }
  const headers = snapshot.fields.map((f) => escapeTableCell(f.name))
  const lines = [`| ${headers.join(' | ')} |`, `| ${snapshot.fields.map(() => '---').join(' | ')} |`]
  for (const record of snapshot.records) {
    const cells = snapshot.fields.map((f) => escapeTableCell(formatCellValue(f, record.fields[f.name])))
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}
