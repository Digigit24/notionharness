import { DocCollection, Schema, Text, type Doc } from '@/lib/blocksuite-store'
import { AffineSchemas } from '@/lib/blocksuite-blocks'
import { NativeDatabaseBlockSchema } from '@/components/editor/blocks/native-database/schema'
import { RunCardBlockSchema } from '@/components/editor/blocks/run-card/schema'
import { MENTION_NODE } from '@/components/editor/mentions/insert-mention'
import type { Payload } from 'payload'
// ROADMAP B8.3 (Batch B-6 "Finish") — module splitting. The pure markdown-
// formatting helpers `docToMarkdown`'s block-serialization walker (below)
// calls have moved to `lib/blocksuite-markdown-helpers.ts` (a sibling with no
// BlockSuite `Doc`/schema dependency of its own); re-exported here so this
// file's previous export surface (`MAX_EXPORT_ROWS`, `TeableDatabaseSnapshot`,
// `DatabaseResolver`, `snapshotToMarkdownTable`) is unchanged for any caller
// that imports them from `@/lib/blocksuite-doc`. See that file's own header
// comment for why this particular split was judged safe to make without
// deep BlockSuite-internals verification.
import {
  escapeTableCell,
  propStr,
  textToString,
  humanSize,
  embedLink,
  snapshotToMarkdownTable,
  MAX_EXPORT_ROWS,
  type TeableDatabaseSnapshot,
  type DatabaseResolver,
} from './blocksuite-markdown-helpers'

export { MAX_EXPORT_ROWS, snapshotToMarkdownTable }
export type { TeableDatabaseSnapshot, DatabaseResolver }

// Server-side (Node) mirror of the headless doc setup in `BlockSuiteEditor.tsx`,
// minus `@blocksuite/*/effects` (those register browser custom elements and
// aren't needed to read/write the block tree). Must register the same custom
// block schemas as the client or hydrating a doc that contains one throws.

export type AnyBlockModel = {
  flavour: string
  children: AnyBlockModel[]
  [key: string]: unknown
}

function createCollection() {
  const schema = new Schema().register(AffineSchemas).register([NativeDatabaseBlockSchema, RunCardBlockSchema])
  const collection = new DocCollection({ schema })
  collection.meta.initialize()
  return collection
}

export function base64ToUpdate(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

export function updateToBase64(update: Uint8Array): string {
  return Buffer.from(update).toString('base64')
}

export function seedEmptyDoc(doc: Doc, title: string) {
  const rootId = doc.addBlock('affine:page', { title: new Text(title) })
  doc.addBlock('affine:surface', {}, rootId)
  const noteId = doc.addBlock('affine:note', {}, rootId)
  doc.addBlock('affine:paragraph', {}, noteId)
  return noteId
}

/** Hydrates a headless doc from a page's `docState` field (`{ update: base64 }`), or seeds a fresh one. */
export function loadDoc(pageId: number, title: string, docState: unknown): { collection: DocCollection; doc: Doc } {
  const collection = createCollection()
  const doc = collection.createDoc({ id: `page-${pageId}` })

  const storedUpdate =
    docState && typeof docState === 'object' && 'update' in (docState as object)
      ? (docState as { update: unknown }).update
      : null

  let hydrated = false
  if (typeof storedUpdate === 'string' && storedUpdate.length > 0) {
    try {
      DocCollection.Y.applyUpdate(doc.spaceDoc, base64ToUpdate(storedUpdate), 'hydrate')
      hydrated = true
    } catch (err) {
      console.error(`Failed to hydrate BlockSuite doc for page ${pageId}, starting fresh.`, err)
    }
  }

  doc.load(() => {
    if (hydrated && doc.root) return
    seedEmptyDoc(doc, title)
  })

  return { collection, doc }
}

export function encodeDocUpdate(doc: Doc): string {
  return updateToBase64(DocCollection.Y.encodeStateAsUpdate(doc.spaceDoc))
}

/**
 * Hydrates a headless doc from a page's `docState` field, same as `loadDoc`,
 * except it never seeds placeholder content when there's nothing to hydrate.
 * Used as a merge target for an incoming Yjs update (`applyDocSync`, agent
 * page-writes): seeding here would create a second root/surface/note tree
 * with the server's own block ids, which then collides with the root the
 * incoming update creates with its own ids the very first time a page syncs
 * — two disjoint page trees merged into one doc. An empty, unseeded `Doc` is
 * a safe, inert merge target; the incoming update supplies the root itself
 * when a page has never synced before.
 */
function loadDocForMerge(pageId: number, docState: unknown): { collection: DocCollection; doc: Doc } {
  const collection = createCollection()
  const doc = collection.createDoc({ id: `page-${pageId}` })

  const storedUpdate =
    docState && typeof docState === 'object' && 'update' in (docState as object)
      ? (docState as { update: unknown }).update
      : null

  if (typeof storedUpdate === 'string' && storedUpdate.length > 0) {
    try {
      DocCollection.Y.applyUpdate(doc.spaceDoc, base64ToUpdate(storedUpdate), 'hydrate')
    } catch (err) {
      console.error(`Failed to hydrate BlockSuite doc for page ${pageId} for merge, starting empty.`, err)
    }
  }

  doc.load()
  return { collection, doc }
}

/**
 * Persists a Yjs update into `docState` and refreshes `plainTextContent`.
 * Shared by the autosave Server Action and the `/sync` route, and now also
 * the only write path agent page-writes use (ROADMAP 6.1), so it has to be
 * safe under concurrent writers.
 *
 * Merges the incoming update into the *currently persisted* state rather
 * than treating the incoming update as the whole new state — Yjs updates are
 * commutative and idempotent (applying A-then-B or B-then-A, or the same
 * update twice, converges to the same result), so this unions whatever the
 * caller sent with whatever's already stored instead of one silently
 * clobbering the other. Previously this loaded a *fresh* doc and applied
 * only the incoming update, so two writers syncing around the same time
 * (e.g. a human's browser tab autosaving while an agent run appends blocks)
 * would have the second write silently erase the first's content — harmless
 * while pages were effectively single-writer-per-session, but exactly the
 * scenario 6.1 introduces on purpose.
 */
export async function applyDocSync(payload: Payload, pageId: number, update: string) {
  const existing = await payload.findByID({ collection: 'pages', id: pageId, overrideAccess: true, depth: 0 })
  const { doc } = loadDocForMerge(pageId, existing.docState)
  DocCollection.Y.applyUpdate(doc.spaceDoc, base64ToUpdate(update), 'sync')
  const merged = encodeDocUpdate(doc)
  const plainTextContent = extractPlainText(doc)
  await payload.update({
    collection: 'pages',
    id: pageId,
    data: { docState: { update: merged }, plainTextContent },
    overrideAccess: true,
  })
}

/**
 * Hydrates the current persisted doc for a page and hands back the live
 * `Doc` plus a `persist()` callback that encodes+saves whatever mutations
 * were made to it. Agent page-writes (ROADMAP 6.1) are the only other
 * caller of this merge-safe load path besides `applyDocSync` itself.
 */
export async function loadDocForWrite(
  payload: Payload,
  pageId: number,
): Promise<{ doc: Doc; title: string; persist: () => Promise<void> }> {
  const existing = await payload.findByID({ collection: 'pages', id: pageId, overrideAccess: true, depth: 0 })
  const { doc } = loadDocForMerge(pageId, existing.docState)
  const persist = async () => {
    const merged = encodeDocUpdate(doc)
    const plainTextContent = extractPlainText(doc)
    await payload.update({
      collection: 'pages',
      id: pageId,
      data: { docState: { update: merged }, plainTextContent },
      overrideAccess: true,
    })
  }
  return { doc, title: existing.title || 'Untitled', persist }
}

export function getNote(doc: Doc): AnyBlockModel | undefined {
  const root = doc.root as unknown as AnyBlockModel | null
  return root?.children.find((c) => c.flavour === 'affine:note')
}

function collectText(model: AnyBlockModel, lines: string[]) {
  const s = textToString(model.text as Parameters<typeof textToString>[0]).trim()
  if (s) lines.push(s)
  for (const child of model.children) collectText(child, lines)
}

/** Flattens all block text into newline-separated plain text, for search/agent context. */
export function extractPlainText(doc: Doc): string {
  const note = getNote(doc)
  if (!note) return ''
  const lines: string[] = []
  for (const child of note.children) collectText(child, lines)
  return lines.join('\n')
}

function paragraphPrefix(type: unknown): string {
  if (typeof type === 'string' && /^h[1-6]$/.test(type)) return '#'.repeat(Number(type[1])) + ' '
  if (type === 'quote') return '> '
  return ''
}

async function serializeChildren(models: AnyBlockModel[], lines: string[], depth: number, resolveDatabase?: DatabaseResolver) {
  const indent = '  '.repeat(depth)
  let numberedIndex = 0

  for (const model of models) {
    const text = textToString(model.text as Parameters<typeof textToString>[0])

    switch (model.flavour) {
      case 'affine:paragraph':
        numberedIndex = 0
        lines.push(indent + paragraphPrefix(model.type) + text)
        lines.push('')
        break
      case 'affine:list':
        if (model.type === 'todo') {
          numberedIndex = 0
          lines.push(`${indent}- [${model.checked ? 'x' : ' '}] ${text}`)
        } else if (model.type === 'numbered') {
          numberedIndex += 1
          lines.push(`${indent}${numberedIndex}. ${text}`)
        } else {
          numberedIndex = 0
          lines.push(`${indent}- ${text}`)
        }
        break
      case 'affine:code':
        numberedIndex = 0
        lines.push(`${indent}\`\`\`${typeof model.language === 'string' ? model.language : ''}`)
        text.split('\n').forEach((l) => lines.push(indent + l))
        lines.push(`${indent}\`\`\``)
        lines.push('')
        break
      case 'affine:divider':
        numberedIndex = 0
        lines.push(`${indent}---`)
        lines.push('')
        break
      case 'affine:embed-teable-native': {
        // Real Teable export: if the block is connected (has a teableDatabaseId)
        // and a resolver is provided (and it yields field+row data), emit a
        // markdown table snapshot instead of the placeholder. Any failure falls
        // back to the placeholder so an unconnected/unresolvable block never
        // breaks the whole export.
        numberedIndex = 0
        if (resolveDatabase && typeof model.teableDatabaseId === 'number') {
          const snapshot = await resolveDatabase(model.teableDatabaseId)
          if (snapshot && snapshot.fields.length) {
            lines.push(`${indent}**Teable database: ${escapeTableCell(snapshot.title || 'Untitled table')}**`)
            lines.push('')
            lines.push(`${indent}${snapshotToMarkdownTable(snapshot)}`)
            if (snapshot.truncated) {
              lines.push('')
              lines.push(`${indent}> _Export truncated to the first ${MAX_EXPORT_ROWS} rows._`)
            }
            lines.push('')
            break
          }
        }
        // Unconnected or unresolvable: keep the v1 placeholder marker. Not
        // recreated on import (see `markdownToDoc`) — it round-trips as text.
        lines.push(`${indent}[Teable database]`)
        lines.push('')
        break
      }
      // ROADMAP 6.3 — a run card is a live-status reference, not something a
      // static markdown export can show status for; degrades to a visible,
      // traceable placeholder (never silently dropped, same standard as
      // every other block here) rather than trying to embed a snapshot that
      // would immediately go stale.
      case 'affine:embed-run-card':
        numberedIndex = 0
        lines.push(`${indent}[Run #${typeof model.runId === 'number' ? model.runId : '?'}]`)
        lines.push('')
        break
      // Rich embeds that degrade to a plain markdown link. The rich embed
      // syntax doesn't exist in markdown, so a link (with title if known) is
      // the correct degraded representation.
      case 'affine:embed-youtube':
      case 'affine:embed-figma':
      case 'affine:embed-github':
      case 'affine:embed-loom': {
        numberedIndex = 0
        lines.push(`${indent}${embedLink(model, `Embed ${model.flavour.replace('affine:embed-', '')}`)}`)
        lines.push('')
        break
      }
      // HTML embeds carry raw HTML source rather than a URL — emit it in a
      // fenced block so nothing is lost.
      case 'affine:embed-html': {
        numberedIndex = 0
        const html = propStr(model, 'html')
        const caption = propStr(model, 'caption')
        if (html) {
          lines.push(`${indent}**Embed HTML${caption ? `: ${escapeTableCell(caption)}` : ''}**`)
          lines.push('')
          lines.push(`${indent}\`\`\`html`)
          html.split('\n').forEach((l) => lines.push(indent + l))
          lines.push(`${indent}\`\`\``)
        } else {
          lines.push(`${indent}[Embed HTML${caption ? `: ${escapeTableCell(caption)}` : ''}]`)
        }
        lines.push('')
        break
      }
      case 'affine:bookmark': {
        numberedIndex = 0
        const url = propStr(model, 'url')
        const title = propStr(model, 'title') || propStr(model, 'caption') || url || 'bookmark'
        if (url) {
          lines.push(`${indent}[${escapeTableCell(title)}](${url})`)
        } else {
          lines.push(`${indent}[Bookmark${title !== 'bookmark' ? `: ${escapeTableCell(title)}` : ''}]`)
        }
        lines.push('')
        break
      }
      // Image/attachment binary is stored as a blob `sourceId` with no public
      // URL in this app; emit markdown syntax tied to the blob id when present,
      // else a visible placeholder. Never silently drop the block.
      case 'affine:image': {
        numberedIndex = 0
        const sourceId = propStr(model, 'sourceId')
        const alt = propStr(model, 'caption') || 'image'
        if (sourceId) {
          lines.push(`${indent}![${escapeTableCell(alt)}](blob:${sourceId})`)
        } else {
          lines.push(`${indent}[Image${alt !== 'image' ? `: ${escapeTableCell(alt)}` : ''}]`)
        }
        lines.push('')
        break
      }
      case 'affine:attachment': {
        numberedIndex = 0
        const sourceId = propStr(model, 'sourceId')
        const name = propStr(model, 'name') || 'attachment'
        const size = humanSize(typeof model.size === 'number' ? model.size : 0)
        if (sourceId) {
          lines.push(`${indent}[${escapeTableCell(name)}](blob:${sourceId})${size}`)
        } else {
          lines.push(`${indent}[Attachment: ${escapeTableCell(name)}]${size}`)
        }
        lines.push('')
        break
      }
      case 'affine:latex': {
        numberedIndex = 0
        lines.push(`${indent}$$$`)
        lines.push(`${indent}${(model.latex as string | undefined) ?? ''}`)
        lines.push(`${indent}$$$`)
        lines.push('')
        break
      }
      // References to another doc: emit a visible link-style marker.
      case 'affine:embed-linked-doc': {
        numberedIndex = 0
        const title = propStr(model, 'title') || propStr(model, 'pageId')
        lines.push(`${indent}[Linked doc${title ? `: ${escapeTableCell(title)}` : ''}]`)
        lines.push('')
        break
      }
      case 'affine:embed-synced-doc': {
        numberedIndex = 0
        const title = propStr(model, 'title') || propStr(model, 'pageId')
        lines.push(`${indent}[Synced doc${title ? `: ${escapeTableCell(title)}` : ''}]`)
        lines.push('')
        break
      }
      // Native (non-Teable) databases: tabular content; a titled placeholder is
      // the floor here — exporting the full table is out of this task's scope.
      case 'affine:database':
      case 'affine:data-view': {
        numberedIndex = 0
        const t = propStr(model, 'title')
        lines.push(`${indent}[Database${t ? `: ${escapeTableCell(t)}` : ''}]`)
        lines.push('')
        break
      }
      case 'affine:surface-ref': {
        numberedIndex = 0
        const ref = propStr(model, 'reference')
        const refFlavour = propStr(model, 'refFlavour')
        lines.push(
          `${indent}[Surface reference${refFlavour ? ` (${refFlavour})` : ''}${ref ? `: ${escapeTableCell(ref)}` : ''}]`,
        )
        lines.push('')
        break
      }
      case 'affine:frame': {
        numberedIndex = 0
        const t = propStr(model, 'title')
        lines.push(`${indent}[Frame${t ? `: ${escapeTableCell(t)}` : ''}]`)
        lines.push('')
        break
      }
      // Containers: emit nothing of their own, their children are serialized
      // below. (The root note is handled by `getNote`; nested ones recurse.)
      case 'affine:note':
      case 'affine:page':
      case 'affine:root':
      case 'affine:surface':
        numberedIndex = 0
        break
      default: {
        // Safety net: never silently drop an unhandled block type. Emit a
        // visible, traceable placeholder so data loss is surfaced rather than
        // silent.
        numberedIndex = 0
        lines.push(`${indent}[Unsupported block: ${model.flavour}]`)
        lines.push('')
        break
      }
    }

    if (model.children.length) await serializeChildren(model.children, lines, depth + 1, resolveDatabase)
  }
}

/** Serializes the doc tree into Markdown with a frontmatter header. */
export async function docToMarkdown(doc: Doc, title: string, resolveDatabase?: DatabaseResolver): Promise<string> {
  const note = getNote(doc)
  const lines: string[] = []
  if (note) await serializeChildren(note.children, lines, 0, resolveDatabase)

  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `exportedAt: ${JSON.stringify(new Date().toISOString())}`,
    '---',
    '',
  ].join('\n')

  return `${frontmatter}\n${body}\n`
}

function parseFrontmatter(markdown: string): { title: string | null; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { title: null, body: markdown }
  const [, fm, body] = match
  const titleLine = fm.match(/^title:\s*(.*)$/m)
  if (!titleLine) return { title: null, body }
  const raw = titleLine[1].trim()
  try {
    return { title: JSON.parse(raw), body }
  } catch {
    return { title: raw, body }
  }
}

/**
 * Builds a `Text` for one markdown line, reconstructing `@name` runs as real
 * mention deltas (see components/editor/mentions/schema.ts) instead of
 * literal `@name` text — the inverse of `textToString`'s mention-flattening
 * above. Falls straight through to `new Text(raw)` (unchanged) when the line
 * has no `@` at all, so this is a no-op for every line that isn't a mention.
 *
 * Deliberately narrow, by necessity rather than convenience: a mention name
 * is taken as a single non-whitespace token with trailing punctuation
 * stripped (`@alice,` -> name "alice"). `docToMarkdown` degrades a mention
 * to plain `@name` text with no id and no word-count hint, so a multi-word
 * display name ("Jane Doe") is textually indistinguishable from "@Jane"
 * followed by the separate word "Doe" — reconstructing anything wider than
 * one token would be guessing at a name boundary, not parsing one, so
 * multi-word display names fall back to plain, non-mention text on import
 * (a further, acknowledged degrade beyond the id loss below).
 *
 * `userId` is left `''` (unresolvable from markdown text alone — nothing at
 * `markdownToDoc`'s current call sites has a name -> user/agent id lookup
 * wired in yet, and building one means cross-referencing the Better Auth
 * `user` table with the workspace-scoped `agents` collection and choosing a
 * winner on a name collision, which is a real feature, not a clean lookup)
 * and `kind` is left unset. Per `MentionAttribute`'s own comment ("mentions
 * persisted before agent mentions existed" get no `kind`), an unset `kind`
 * is an existing, handled shape, not a new one — so this reconstructs a
 * *best-effort* mention: a real, correctly-shaped delta that renders and
 * round-trips through markdown by name, just not yet resolvable back to the
 * account/agent it named.
 */
function buildInlineText(raw: string): Text {
  const pattern = /@([^\s@]+)/g
  if (!pattern.test(raw)) return new Text(raw)

  const delta: { insert: string; attributes?: Record<string, unknown> }[] = []
  let last = 0
  let match: RegExpExecArray | null
  pattern.lastIndex = 0
  while ((match = pattern.exec(raw))) {
    const trailingPunct = match[1].match(/[.,!?;:)\]}]+$/)?.[0] ?? ''
    const name = trailingPunct ? match[1].slice(0, -trailingPunct.length) : match[1]
    if (!name) continue // bare "@" or "@," etc — leave as plain text, nothing to mention
    if (match.index > last) delta.push({ insert: raw.slice(last, match.index) })
    delta.push({ insert: MENTION_NODE, attributes: { mention: { userId: '', name } } })
    if (trailingPunct) delta.push({ insert: trailingPunct })
    last = match.index + match[0].length
  }
  if (last < raw.length) delta.push({ insert: raw.slice(last) })
  return delta.length ? new Text(delta) : new Text(raw)
}

/** Parses raw Markdown into a fresh headless doc's block tree (paragraphs, headings, quotes, lists, todos, code, dividers, run cards, best-effort mentions). */
export function markdownToDoc(
  pageId: number,
  markdown: string,
  fallbackTitle: string,
): { collection: DocCollection; doc: Doc; title: string } {
  const { title: fmTitle, body } = parseFrontmatter(markdown)
  const title = fmTitle || fallbackTitle

  const collection = createCollection()
  const doc = collection.createDoc({ id: `page-${pageId}` })

  doc.load(() => {
    const rootId = doc.addBlock('affine:page', { title: new Text(title) })
    doc.addBlock('affine:surface', {}, rootId)
    const noteId = doc.addBlock('affine:note', {}, rootId)

    const lines = body.split(/\r?\n/)
    let i = 0
    let addedAny = false

    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') {
        i++
        continue
      }

      const codeFence = line.match(/^```(\w*)\s*$/)
      if (codeFence) {
        const language = codeFence[1] || null
        const codeLines: string[] = []
        i++
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i])
          i++
        }
        i++
        doc.addBlock('affine:code', { text: new Text(codeLines.join('\n')), language }, noteId)
        addedAny = true
        continue
      }

      if (/^(---|\*\*\*|___)\s*$/.test(line)) {
        doc.addBlock('affine:divider', {}, noteId)
        addedAny = true
        i++
        continue
      }

      // ROADMAP B-2 — inverse of the `affine:embed-run-card` export case
      // above (`[Run #<id>]`, whole-line, no children). Matches that exact
      // shape; the unresolvable placeholder `[Run #?]` has no digits to
      // parse and correctly falls through to a plain paragraph below, same
      // as before — there's no id to reconstruct a run card from.
      const runCard = line.match(/^\[Run #(\d+)\]$/)
      if (runCard) {
        doc.addBlock('affine:embed-run-card', { runId: Number(runCard[1]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      if (heading) {
        const headingType = `h${heading[1].length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        doc.addBlock('affine:paragraph', { type: headingType, text: buildInlineText(heading[2]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const quote = line.match(/^>\s?(.*)$/)
      if (quote) {
        doc.addBlock('affine:paragraph', { type: 'quote', text: buildInlineText(quote[1]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const todo = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/)
      if (todo) {
        doc.addBlock('affine:list', { type: 'todo', checked: /x/i.test(todo[1]), text: buildInlineText(todo[2]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const numbered = line.match(/^\d+\.\s+(.*)$/)
      if (numbered) {
        doc.addBlock('affine:list', { type: 'numbered', text: buildInlineText(numbered[1]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const bulleted = line.match(/^[-*]\s+(.*)$/)
      if (bulleted) {
        doc.addBlock('affine:list', { type: 'bulleted', text: buildInlineText(bulleted[1]) }, noteId)
        addedAny = true
        i++
        continue
      }

      doc.addBlock('affine:paragraph', { type: 'text', text: buildInlineText(line) }, noteId)
      addedAny = true
      i++
    }

    if (!addedAny) doc.addBlock('affine:paragraph', {}, noteId)
  })

  return { collection, doc, title }
}
