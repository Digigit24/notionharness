import { DocCollection, Schema, Text, type Doc } from '@blocksuite/store'
import { AffineSchemas } from '@blocksuite/blocks/schemas'
import type { Payload } from 'payload'

// Server-side (Node) mirror of the headless doc setup in `BlockSuiteEditor.tsx`,
// minus `@blocksuite/*/effects` (those register browser custom elements and
// aren't needed to read/write the block tree).

type AnyBlockModel = {
  flavour: string
  children: AnyBlockModel[]
  [key: string]: unknown
}

function createCollection() {
  const schema = new Schema().register(AffineSchemas)
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

function seedEmptyDoc(doc: Doc, title: string) {
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

/** Persists a Yjs update into `docState` and refreshes `plainTextContent` from it. Shared by the autosave Server Action and the `/sync` route. */
export async function applyDocSync(payload: Payload, pageId: number, update: string) {
  const { doc } = loadDoc(pageId, 'Untitled', { update })
  const plainTextContent = extractPlainText(doc)
  await payload.update({
    collection: 'pages',
    id: pageId,
    data: { docState: { update }, plainTextContent },
    overrideAccess: true,
  })
}

function getNote(doc: Doc): AnyBlockModel | undefined {
  const root = doc.root as unknown as AnyBlockModel | null
  return root?.children.find((c) => c.flavour === 'affine:note')
}

function collectText(model: AnyBlockModel, lines: string[]) {
  const text = model.text as { toString(): string } | undefined
  if (text && typeof text.toString === 'function') {
    const s = text.toString().trim()
    if (s) lines.push(s)
  }
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

function serializeChildren(models: AnyBlockModel[], lines: string[], depth: number) {
  const indent = '  '.repeat(depth)
  let numberedIndex = 0

  for (const model of models) {
    const text = (model.text as { toString(): string } | undefined)?.toString() ?? ''

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
      default:
        break
    }

    if (model.children.length) serializeChildren(model.children, lines, depth + 1)
  }
}

/** Serializes the doc tree into Markdown with a frontmatter header. */
export function docToMarkdown(doc: Doc, title: string): string {
  const note = getNote(doc)
  const lines: string[] = []
  if (note) serializeChildren(note.children, lines, 0)

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

/** Parses raw Markdown into a fresh headless doc's block tree (paragraphs, headings, quotes, lists, todos, code, dividers). */
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

      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      if (heading) {
        const headingType = `h${heading[1].length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        doc.addBlock('affine:paragraph', { type: headingType, text: new Text(heading[2]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const quote = line.match(/^>\s?(.*)$/)
      if (quote) {
        doc.addBlock('affine:paragraph', { type: 'quote', text: new Text(quote[1]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const todo = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/)
      if (todo) {
        doc.addBlock('affine:list', { type: 'todo', checked: /x/i.test(todo[1]), text: new Text(todo[2]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const numbered = line.match(/^\d+\.\s+(.*)$/)
      if (numbered) {
        doc.addBlock('affine:list', { type: 'numbered', text: new Text(numbered[1]) }, noteId)
        addedAny = true
        i++
        continue
      }

      const bulleted = line.match(/^[-*]\s+(.*)$/)
      if (bulleted) {
        doc.addBlock('affine:list', { type: 'bulleted', text: new Text(bulleted[1]) }, noteId)
        addedAny = true
        i++
        continue
      }

      doc.addBlock('affine:paragraph', { type: 'text', text: new Text(line) }, noteId)
      addedAny = true
      i++
    }

    if (!addedAny) doc.addBlock('affine:paragraph', {}, noteId)
  })

  return { collection, doc, title }
}
