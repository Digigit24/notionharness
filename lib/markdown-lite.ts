/**
 * R14-P0.4 — markdown-LITE, deliberately not the repo's markdown renderer.
 *
 * `lib/git/highlight.ts` already renders real markdown (`renderMarkdown`, via
 * `marked`) for README previews, and Shiki is already wired up there for
 * syntax-highlighted repository files. Neither is reused here, and both
 * decisions are worth stating rather than assuming:
 *
 *   - Shiki tokenises a whole file with a loaded grammar — the right tool for
 *     ONE file a person opened on purpose. A chat message is the opposite
 *     shape: many small bodies, rendered continuously as a feed scrolls, most
 *     of them with no code in them at all. `lib/git/highlight.ts`'s OWN
 *     comment on its markdown code renderer makes exactly this call already
 *     ("Deliberately not run through shiki... loading a dozen grammars to
 *     colour a preview would cost more than the preview is worth") for a
 *     README with a dozen fenced blocks; a busy channel has that many fenced
 *     blocks per minute. Fenced code below renders as plain `<pre><code>`,
 *     the same conclusion that file already reached for the same reason.
 *   - `renderMarkdown`'s full GFM grammar (headings, tables, arbitrary HTML
 *     neutralisation, images, footnotes) is the wrong SURFACE for a chat
 *     message, not merely the wrong performance trade-off. A message is not
 *     a document — R14-P0.4 names the grammar explicitly: bold, italic,
 *     inline code, quote, list, and fenced code. Reusing `marked` here would
 *     silently let a channel message render an `<h1>` or a `<table>`, which
 *     is not a feature this phase asked for and not a look a chat feed wants.
 *
 * So: a small, hand-written, LINE-ORIENTED converter. HTML is escaped FIRST,
 * unconditionally, before any marker is recognised — every marker match runs
 * against already-inert text, so there is no path from message content to a
 * live tag the way an unescaped-then-sanitised pipeline would have to guard
 * against separately for every marker added later.
 */

// ---------------------------------------------------------------------------
// Textarea editing helpers — the toolbar's actual job. Every one of these
// takes a value + selection and returns the same shape back, so
// `message-composer.tsx` can apply the result to the textarea and restore the
// caret in one place rather than each button reimplementing that dance.

export interface TextEdit {
  value: string
  selectionStart: number
  selectionEnd: number
}

/**
 * Bold/italic/inline-code. Wraps the selection in `marker` on both sides; if
 * the selection is ALREADY wrapped in exactly that marker, unwraps it instead
 * — this is what makes Cmd+B a TOGGLE rather than a one-way "add more
 * asterisks" button, the same behavior every rich-text editor's bold button
 * has trained people to expect even from a plain-text one.
 */
export function toggleWrap(text: string, start: number, end: number, marker: string): TextEdit {
  const before = text.slice(0, start)
  const selected = text.slice(start, end)
  const after = text.slice(end)

  const alreadyWrapped =
    before.endsWith(marker) && after.startsWith(marker) &&
    // Guards against unwrapping `**bold**` when the marker is the single
    // character `*` and the selection sits just inside a DOUBLE marker —
    // without this, toggling italic (`*`) on text already bold-wrapped
    // (`**`) would eat one asterisk from each side instead of doing nothing.
    !(marker.length === 1 && (before.endsWith(marker + marker) || after.startsWith(marker + marker)))

  if (alreadyWrapped) {
    const newBefore = before.slice(0, before.length - marker.length)
    const newAfter = after.slice(marker.length)
    return {
      value: newBefore + selected + newAfter,
      selectionStart: newBefore.length,
      selectionEnd: newBefore.length + selected.length,
    }
  }

  const value = before + marker + selected + marker + after
  return {
    value,
    // No selection (a bare toggle keypress with just a caret): land the
    // caret BETWEEN the markers so typing continues inside them, matching
    // what every editor does for "bold, then type".
    selectionStart: start + marker.length,
    selectionEnd: start + marker.length + selected.length,
  }
}

/**
 * Quote (`> `) / list (`- `) — a LINE prefix, toggled per line across the
 * selection (or the current line, when the selection is just a caret). Lines
 * already carrying the prefix have it removed instead, so pressing the same
 * toolbar button twice returns to plain text rather than stacking `> > `.
 */
export function toggleLinePrefix(text: string, start: number, end: number, prefix: string): TextEdit {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nextBreak = text.indexOf('\n', end)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  const block = text.slice(lineStart, lineEnd)
  const lines = block.split('\n')

  const allPrefixed = lines.every((line) => line.startsWith(prefix) || line.length === 0)
  const nextLines = lines.map((line) => {
    if (line.length === 0) return line
    return allPrefixed ? line.slice(prefix.length) : prefix + line
  })
  const nextBlock = nextLines.join('\n')

  const value = text.slice(0, lineStart) + nextBlock + text.slice(lineEnd)
  const delta = nextBlock.length - block.length
  return {
    value,
    selectionStart: Math.max(lineStart, start + (allPrefixed ? -prefix.length : prefix.length)),
    selectionEnd: end + delta,
  }
}

/**
 * ``` fencing. Wraps a selection spanning one or more lines in its own fenced
 * block; with no selection, inserts an empty fence and leaves the caret on
 * the blank line inside it.
 */
export function insertCodeFence(text: string, start: number, end: number): TextEdit {
  const selected = text.slice(start, end)
  const before = text.slice(0, start)
  const after = text.slice(end)
  // A fence must start its own line — if the caret is mid-line, open one.
  const needsLeadingBreak = before.length > 0 && !before.endsWith('\n')
  const needsTrailingBreak = after.length > 0 && !after.startsWith('\n')

  const fenced = selected.length > 0 ? `\`\`\`\n${selected}\n\`\`\`` : '```\n\n```'
  const value = `${before}${needsLeadingBreak ? '\n' : ''}${fenced}${needsTrailingBreak ? '\n' : ''}${after}`

  const fenceStart = start + (needsLeadingBreak ? 1 : 0)
  if (selected.length > 0) {
    return { value, selectionStart: fenceStart + 4, selectionEnd: fenceStart + 4 + selected.length }
  }
  // Empty fence: land the caret on the blank line between the two ``` rows.
  const caret = fenceStart + 4
  return { value, selectionStart: caret, selectionEnd: caret }
}

// ---------------------------------------------------------------------------
// Rendering — used by the composer's own preview toggle. Any future rendering
// of a SENT message (the channel feed's `message-row.tsx`, owned by a
// different unit for this phase — see this file's own PR notes) can import
// this unchanged; it takes plain text in and returns safe HTML, nothing more.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Inline markers only — no block structure. Applied to text that has
 * ALREADY been through `escapeHtml`, so every character these regexes see is
 * inert; there is no way for `<script>` typed into a message to become a tag,
 * only ever the literal text `&lt;script&gt;` wrapped in whatever `<em>`/
 * `<strong>`/`<code>` the surrounding markers ask for. */
function renderInline(escaped: string): string {
  return escaped
    // Inline code first: its contents must not be re-processed by bold/italic
    // below, so `` `*not bold*` `` renders literally.
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])_([^_\n]+)_(?!\w)/g, '<em>$1</em>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
}

/**
 * The whole grammar: fenced code blocks (verbatim, escaped, unprocessed
 * inline), then `> ` quote lines and `- `/`* ` list lines grouped into
 * `<blockquote>`/`<ul>`, then inline formatting on everything left over.
 */
export function renderMarkdownLite(source: string): string {
  const parts = source.split(/```/)
  // An odd number of ``` markers means an unterminated fence — treated as
  // plain text rather than silently eating the rest of the message, which is
  // what an unbounded "everything after this is code" rule would do to a
  // message that just happens to contain a lone stray ``` some time later.
  const hasBalancedFences = parts.length % 2 === 1

  const blocks: string[] = []
  parts.forEach((part, index) => {
    const isFence = hasBalancedFences && index % 2 === 1
    if (isFence) {
      // Drop one optional language tag on the fence's own first line — not
      // used for highlighting (see this file's header), only stripped so it
      // does not print as a stray word above the code.
      const body = part.replace(/^[^\n]*\n?/, (m) => (m.trim().length > 0 && !m.includes(' ') ? '' : m))
      blocks.push(`<pre class="md-lite-code"><code>${escapeHtml(body).replace(/\n$/, '')}</code></pre>`)
      return
    }
    blocks.push(renderTextBlock(part))
  })
  return blocks.join('')
}

function renderTextBlock(text: string): string {
  const lines = text.split('\n')
  const html: string[] = []
  let quoteBuffer: string[] = []
  let listBuffer: string[] = []

  const flushQuote = () => {
    if (quoteBuffer.length === 0) return
    html.push(`<blockquote>${quoteBuffer.map((l) => renderInline(escapeHtml(l))).join('<br/>')}</blockquote>`)
    quoteBuffer = []
  }
  const flushList = () => {
    if (listBuffer.length === 0) return
    html.push(`<ul>${listBuffer.map((l) => `<li>${renderInline(escapeHtml(l))}</li>`).join('')}</ul>`)
    listBuffer = []
  }

  for (const line of lines) {
    const quoteMatch = /^>\s?(.*)$/.exec(line)
    const listMatch = /^[-*]\s+(.*)$/.exec(line)
    if (quoteMatch) {
      flushList()
      quoteBuffer.push(quoteMatch[1])
      continue
    }
    if (listMatch) {
      flushQuote()
      listBuffer.push(listMatch[1])
      continue
    }
    flushQuote()
    flushList()
    if (line.length === 0) {
      html.push('<br/>')
    } else {
      html.push(`<span>${renderInline(escapeHtml(line))}</span><br/>`)
    }
  }
  flushQuote()
  flushList()
  return html.join('')
}
