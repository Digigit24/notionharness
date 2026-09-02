// ROADMAP B-2 "Moat" — real, automated coverage for `docToMarkdown` /
// `markdownToDoc` round-tripping, per block flavour. There was no prior
// markdown round-trip script under scripts/ to fold into this (the only
// blocksuite-doc-adjacent one, scripts/test-agent-page-writes.ts, covers
// agent page-write CRDT merging, not markdown import/export) — this file is
// new coverage, not a replacement for anything, so nothing there needs to
// be deprecated.
//
// Every fixture doc is built directly through the block API (not by parsing
// markdown), so the export direction is exercised honestly. Each test then
// round-trips: original doc -> markdown (md1) -> reimported doc -> markdown
// (md2). Where a flavour is fully recoverable (everything here except
// mention), the *body* (frontmatter stripped) is byte-for-byte identical
// between the two exports — comparing the full markdown string including
// frontmatter would be flaky, since `docToMarkdown` stamps a fresh
// `exportedAt` timestamp into it on every call. Mention is checked by
// meaningful content instead of full delta equality — see that test's
// comment for why: the export format degrades a mention to `@name` text
// with no id, so a reimported mention can only ever be resolved by name,
// not by full identity.

import { describe, expect, it } from 'vitest'
import { docToMarkdown, markdownToDoc, getNote } from '@/lib/blocksuite-doc'
import { DocCollection, Schema, Text, type Doc } from '@/lib/blocksuite-store'
import { AffineSchemas } from '@/lib/blocksuite-blocks'
import { NativeDatabaseBlockSchema } from '@/components/editor/blocks/native-database/schema'
import { RunCardBlockSchema } from '@/components/editor/blocks/run-card/schema'
import { MENTION_NODE } from '@/components/editor/mentions/insert-mention'

interface FixtureBlock {
  flavour: string
  props?: Record<string, unknown>
  text?: Text
}

interface SimpleModel {
  flavour: string
  children: SimpleModel[]
  text?: { toDelta(): { insert?: string; attributes?: Record<string, unknown> }[] }
  [key: string]: unknown
}

let nextPageId = 1000
function pageId(): number {
  nextPageId += 1
  return nextPageId
}

// Mirrors `createCollection`/the page-surface-note seed shape in
// lib/blocksuite-doc.ts exactly (same schema registration, same skeleton)
// so a fixture built here is indistinguishable, to the code under test,
// from a doc built by the app's own client editor or by `markdownToDoc`.
function buildFixtureDoc(id: string, blocks: FixtureBlock[]): Doc {
  const schema = new Schema().register(AffineSchemas).register([NativeDatabaseBlockSchema, RunCardBlockSchema])
  const collection = new DocCollection({ schema })
  collection.meta.initialize()
  const doc = collection.createDoc({ id })
  doc.load(() => {
    const rootId = doc.addBlock('affine:page', { title: new Text('Fixture') })
    doc.addBlock('affine:surface', {}, rootId)
    const noteId = doc.addBlock('affine:note', {}, rootId)
    for (const block of blocks) {
      const props = { ...(block.props ?? {}), ...(block.text ? { text: block.text } : {}) }
      // Fixture builder needs to add arbitrary flavours by string; BlockSuite's
      // `addBlock` overloads only accept flavour literals, hence the casts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc.addBlock(block.flavour as any, props as any, noteId)
    }
  })
  return doc
}

function noteChildren(doc: Doc): SimpleModel[] {
  const note = getNote(doc) as unknown as SimpleModel
  return note.children
}

// Mirrors `parseFrontmatter`'s own regex in lib/blocksuite-doc.ts (not
// exported, so duplicated here) to strip the `---`-delimited frontmatter
// block off an exported markdown string, leaving only the part
// `markdownToDoc` actually parses blocks out of — the part that's
// meaningful to compare across a round trip.
function bodyOf(markdown: string): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  return (match ? match[2] : markdown).trim()
}

async function roundTrip(doc: Doc, id: number, title = 'Fixture') {
  const md1 = await docToMarkdown(doc, title)
  const { doc: reimported } = markdownToDoc(id, md1, title)
  const md2 = await docToMarkdown(reimported, title)
  return { md1, md2, body1: bodyOf(md1), body2: bodyOf(md2), reimported }
}

describe('markdown round trip', () => {
  it('paragraph', async () => {
    const doc = buildFixtureDoc('p1', [
      { flavour: 'affine:paragraph', props: { type: 'text' }, text: new Text('Plain paragraph text.') },
    ])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body1).toContain('Plain paragraph text.')
    expect(body2).toBe(body1)
  })

  it('heading', async () => {
    const doc = buildFixtureDoc('p2', [
      { flavour: 'affine:paragraph', props: { type: 'h2' }, text: new Text('Section heading') },
    ])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body1).toContain('## Section heading')
    expect(body2).toBe(body1)
  })

  it('quote', async () => {
    const doc = buildFixtureDoc('p3', [
      { flavour: 'affine:paragraph', props: { type: 'quote' }, text: new Text('A quoted line.') },
    ])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body1).toContain('> A quoted line.')
    expect(body2).toBe(body1)
  })

  it('divider', async () => {
    const doc = buildFixtureDoc('p4', [{ flavour: 'affine:divider' }])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body1).toContain('---')
    expect(body2).toBe(body1)
  })

  it('code', async () => {
    const doc = buildFixtureDoc('p5', [
      { flavour: 'affine:code', props: { language: 'javascript' }, text: new Text('const x = 1;\nconsole.log(x);') },
    ])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body1).toContain('```javascript')
    expect(body1).toContain('console.log(x);')
    expect(body2).toBe(body1)
  })

  it('bulleted list', async () => {
    const doc = buildFixtureDoc('p6', [
      { flavour: 'affine:list', props: { type: 'bulleted' }, text: new Text('First bullet') },
      { flavour: 'affine:list', props: { type: 'bulleted' }, text: new Text('Second bullet') },
    ])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body1).toContain('- First bullet')
    expect(body1).toContain('- Second bullet')
    expect(body2).toBe(body1)
  })

  it('numbered list', async () => {
    // Sequential, starting at 1 — `docToMarkdown` always renumbers a
    // numbered-list run from sibling position (see `numberedIndex` in
    // `serializeChildren`), never from a stored `order` prop, so this is
    // the only starting point that's byte-identical across a round trip;
    // that renumbering behavior itself predates this task and is out of
    // scope here.
    const doc = buildFixtureDoc('p7', [
      { flavour: 'affine:list', props: { type: 'numbered' }, text: new Text('First item') },
      { flavour: 'affine:list', props: { type: 'numbered' }, text: new Text('Second item') },
    ])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body1).toContain('1. First item')
    expect(body1).toContain('2. Second item')
    expect(body2).toBe(body1)
  })

  it('todo list', async () => {
    const doc = buildFixtureDoc('p8', [
      { flavour: 'affine:list', props: { type: 'todo', checked: true }, text: new Text('Done thing') },
      { flavour: 'affine:list', props: { type: 'todo', checked: false }, text: new Text('Not done thing') },
    ])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body1).toContain('- [x] Done thing')
    expect(body1).toContain('- [ ] Not done thing')
    expect(body2).toBe(body1)
  })

  it('run card — reconstructed from [Run #<id>] on import', async () => {
    const doc = buildFixtureDoc('p9', [{ flavour: 'affine:embed-run-card', props: { runId: 42 } }])
    const { body1, body2, reimported } = await roundTrip(doc, pageId())
    expect(body1).toContain('[Run #42]')
    expect(body2).toBe(body1)
    const children = noteChildren(reimported)
    expect(children).toHaveLength(1)
    expect(children[0].flavour).toBe('affine:embed-run-card')
    expect(children[0].runId).toBe(42)
  })

  it('run card placeholder with no id is not reconstructed (nothing to recover)', async () => {
    // `[Run #?]` is the export fallback for a block whose `runId` isn't a
    // number (see the `affine:embed-run-card` case in `serializeChildren`);
    // unlike `[Run #<n>]` there is no id in that text, so it correctly
    // falls through to a plain paragraph on import, same as before this
    // task's changes.
    const { doc: reimported } = markdownToDoc(pageId(), '[Run #?]', 'Fixture')
    const children = noteChildren(reimported)
    expect(children[0].flavour).toBe('affine:paragraph')
    expect(children[0].text?.toDelta().map((d) => d.insert).join('')).toBe('[Run #?]')
  })

  it('mention (best effort — name round-trips, id does not)', async () => {
    // The exported markdown for a mention is plain `@name` text with no id
    // (see `textToString`) — `userId`/`kind` cannot be recovered from that
    // text alone (see `buildInlineText`'s comment in lib/blocksuite-doc.ts),
    // so this asserts what *is* recoverable: the markdown round-trips
    // byte-for-byte on a second export, and the reconstructed delta is a
    // real mention (not literal "@alice" text) carrying the right name.
    const doc = buildFixtureDoc('p10', [
      {
        flavour: 'affine:paragraph',
        props: { type: 'text' },
        text: new Text([
          { insert: 'Assigned to ' },
          { insert: MENTION_NODE, attributes: { mention: { userId: 'u-123', name: 'alice', kind: 'user' } } },
          { insert: ' for review.' },
        ]),
      },
    ])
    const { body1, body2, reimported } = await roundTrip(doc, pageId())
    expect(body1).toBe('Assigned to @alice for review.')
    expect(body2).toBe(body1) // reconstructed mention re-exports identically to the original
    const delta = noteChildren(reimported)[0].text?.toDelta() ?? []
    const mentionOp = delta.find((op) => op.attributes?.mention)
    expect(mentionOp?.attributes?.mention).toMatchObject({ name: 'alice' })
    // The gap this test documents: a real id is not recoverable from text alone.
    expect((mentionOp?.attributes?.mention as { userId: string }).userId).toBe('')
  })

  it('mention with a multi-word display name is not reconstructed (name boundary is ambiguous)', async () => {
    // A multi-word name is textually indistinguishable from "@FirstWord"
    // followed by a separate plain word, so `buildInlineText` deliberately
    // takes only the first token as the mention name — "Jane Doe" comes
    // back as a mention named "Jane" plus the literal word "Doe", not a
    // single mention named "Jane Doe". This documents the known
    // limitation rather than silently mis-parsing it.
    const { doc: reimported } = markdownToDoc(pageId(), 'cc @Jane Doe on this', 'Fixture')
    const delta = noteChildren(reimported)[0].text?.toDelta() ?? []
    const mentionOp = delta.find((op) => op.attributes?.mention)
    expect((mentionOp?.attributes?.mention as { name: string } | undefined)?.name).toBe('Jane')
    expect(delta.map((op) => op.insert).join('')).toContain('Doe')
  })

  it('teable database placeholder is intentionally not reconstructed (deprecated, migration-only)', async () => {
    // Per HANDOFF.md: "Teable has been retired in favor of the native
    // Postgres-backed UserDatabaseDataSource ... legacy Teable blocks
    // remain retained only for migration/read compatibility." Building
    // round-trip reconstruction for a deprecated, write-frozen block type
    // isn't worth it (ROADMAP B-2 scope decision) — this test locks in the
    // existing, deliberate one-way degrade (placeholder text -> plain
    // paragraph on import) as documented behavior, not an oversight.
    const doc = buildFixtureDoc('p11', [{ flavour: 'affine:embed-teable-native', props: {} }])
    const md1 = await docToMarkdown(doc, 'Fixture')
    expect(bodyOf(md1)).toContain('[Teable database]')
    const { doc: reimported } = markdownToDoc(pageId(), md1, 'Fixture')
    const children = noteChildren(reimported)
    expect(children[0].flavour).toBe('affine:paragraph')
    expect(children[0].text?.toDelta().map((d) => d.insert).join('')).toBe('[Teable database]')
  })

  it('multi-block page round-trips as a whole', async () => {
    const doc = buildFixtureDoc('p12', [
      { flavour: 'affine:paragraph', props: { type: 'h1' }, text: new Text('Weekly update') },
      { flavour: 'affine:paragraph', props: { type: 'text' }, text: new Text('Summary paragraph.') },
      { flavour: 'affine:list', props: { type: 'bulleted' }, text: new Text('Point one') },
      { flavour: 'affine:list', props: { type: 'bulleted' }, text: new Text('Point two') },
      { flavour: 'affine:divider' },
      { flavour: 'affine:embed-run-card', props: { runId: 7 } },
      { flavour: 'affine:code', props: { language: 'ts' }, text: new Text('export const ok = true') },
    ])
    const { body1, body2 } = await roundTrip(doc, pageId())
    expect(body2).toBe(body1)
  })
})
