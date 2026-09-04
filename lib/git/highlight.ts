// R9.2/R9.3 — turning a repository file into HTML, on the server.
//
// Both halves of that sentence matter. "Into HTML" because the browser gets
// marked-up text and no highlighter: shipping shiki to the client would put
// grammar loading and tokenisation on the render path of every file view,
// which is precisely the cost D0 forbids and the largest single latency win
// available in this pillar. "On the server" because the same call is then
// reachable from a server component and from a server action, so a deep link
// renders highlighted on first paint with no round trip at all.
//
// A note on the shiki version. It is pinned in package.json at 1.29.2
// specifically so this file and BlockSuite share one copy; if it ever
// resolves to two, the bundle carries two highlighters and a BlockSuite bump
// silently changes how our code renders.
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'
// `marked` is what R9.3 names, and it is present — but as a PEER dependency
// of monaco-editor (via BlockSuite), not as a direct dependency of ours.
// package.json is outside this unit's owned paths so it could not be promoted
// here; it should be. Until it is, a dependency change that drops monaco
// takes markdown preview with it, and the failure would be a build error
// rather than anything silent.
import { Marked } from 'marked'

// ---------------------------------------------------------------------------
// Limits

/** Past this, highlighting stops being worth its cost: shiki tokenises the
 * whole buffer, and a 400 KB file is already well past what anyone reads in a
 * browser. Bigger files still render, with a gutter and no colour, and say
 * so. */
const MAX_HIGHLIGHT_BYTES = 400_000

/** A minified bundle is one enormous line or a hundred thousand short ones;
 * either way the tokeniser is the wrong tool and the plain path is faster and
 * just as readable. */
const MAX_HIGHLIGHT_LINES = 8_000

/** Themes are loaded once, for both colour schemes, and switched in CSS —
 * see `REPO_CODE_STYLES` in components/repo/repo-code-styles.tsx. Rendering
 * twice (once per theme) would double the server work for something a CSS
 * variable does for free. */
const THEMES = { light: 'github-light', dark: 'github-dark' } as const

// ---------------------------------------------------------------------------
// The highlighter

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLanguages = new Map<string, Promise<void>>()

/**
 * One highlighter per server process, created on first use.
 *
 * Deliberately not created at module load: shiki's constructor loads the
 * oniguruma WASM engine and both themes, which would be paid by every route
 * in the app on cold start rather than only by the file view.
 */
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [] })
  return highlighterPromise
}

/** Grammars are loaded on demand and kept. The in-flight promise is cached
 * too, so ten files of the same language opened at once load one grammar
 * rather than ten. */
async function ensureLanguage(highlighter: Highlighter, lang: string): Promise<boolean> {
  if (lang === 'text') return true
  if (!(lang in bundledLanguages)) return false
  if (highlighter.getLoadedLanguages().includes(lang)) return true
  let pending = loadedLanguages.get(lang)
  if (!pending) {
    pending = highlighter.loadLanguage(lang as BundledLanguage).then(() => undefined)
    loadedLanguages.set(lang, pending)
  }
  try {
    await pending
    return true
  } catch {
    // A grammar that fails to load is not a reason to fail the file view.
    loadedLanguages.delete(lang)
    return false
  }
}

/**
 * Filename to shiki language id.
 *
 * Extension-driven, with a short list of extensionless filenames that carry
 * real syntax. Anything unrecognised falls through to `text`, which shiki
 * handles natively — a wrong guess would colour the file misleadingly, which
 * is worse than no colour.
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'jsonc', json5: 'json5',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  md: 'markdown', mdx: 'mdx', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'fish', ps1: 'powershell', bat: 'bat', cmd: 'bat',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', pl: 'perl', lua: 'lua', r: 'r', scala: 'scala', dart: 'dart',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  dockerfile: 'docker', tf: 'terraform', hcl: 'hcl', prisma: 'prisma', diff: 'diff', patch: 'diff',
}

const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  cmakelists: 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.env': 'dotenv',
}

export function languageForPath(path: string): string {
  const name = path.split('/').pop() ?? path
  const lower = name.toLowerCase()
  if (FILENAME_LANGUAGES[lower]) return FILENAME_LANGUAGES[lower]
  const base = lower.split('.')[0]
  if (FILENAME_LANGUAGES[base]) return FILENAME_LANGUAGES[base]
  const dot = lower.lastIndexOf('.')
  if (dot > 0) {
    const ext = lower.slice(dot + 1)
    if (EXTENSION_LANGUAGES[ext]) return EXTENSION_LANGUAGES[ext]
  }
  return 'text'
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface HighlightedFile {
  html: string
  lang: string
  lineCount: number
  /** False when the plain fallback was used — the UI says why rather than
   * letting an uncoloured file look like a rendering bug. */
  highlighted: boolean
  reason: string | null
}

function splitLines(code: string): string[] {
  const lines = code.split('\n')
  // A trailing newline is not an extra empty line to anybody reading the
  // file, and numbering it produces a phantom last line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The uncoloured path, emitting exactly the markup shiki emits.
 *
 * Same `<pre class="shiki"><code>` and same `<span class="line" id="L…">`, so
 * the gutter, the line anchors and the deep-link highlight all keep working
 * on a file too large to tokenise. One rendering path in the CSS, two ways of
 * producing it.
 */
function plainHtml(code: string, reason: string): { html: string; lineCount: number; reason: string } {
  const lines = splitLines(code)
  const body = lines
    .map((line, index) => `<span class="line" id="L${index + 1}" data-line="${index + 1}">${escapeHtml(line)}</span>`)
    .join('\n')
  return { html: `<pre class="shiki repo-plain"><code>${body}</code></pre>`, lineCount: lines.length, reason }
}

/**
 * A file's source as HTML, highlighted where that is affordable.
 *
 * Every line carries `id="L<n>"` and `data-line="<n>"`. The id is what makes
 * `#L42` deep-linkable, and the data attribute is what the CSS gutter prints
 * — so line numbers cost no extra DOM and, importantly, are not selectable,
 * which means copying a block of code copies the code and not the numbers.
 */
export async function highlightFile(code: string, path: string): Promise<HighlightedFile> {
  const lang = languageForPath(path)

  if (code.length > MAX_HIGHLIGHT_BYTES) {
    const plain = plainHtml(code, `This file is over ${Math.round(MAX_HIGHLIGHT_BYTES / 1000)} KB, so it is shown without highlighting.`)
    return { html: plain.html, lang, lineCount: plain.lineCount, highlighted: false, reason: plain.reason }
  }
  const lineCount = splitLines(code).length
  if (lineCount > MAX_HIGHLIGHT_LINES) {
    const plain = plainHtml(code, `This file has ${lineCount.toLocaleString()} lines, so it is shown without highlighting.`)
    return { html: plain.html, lang, lineCount: plain.lineCount, highlighted: false, reason: plain.reason }
  }

  try {
    const highlighter = await getHighlighter()
    const resolved = (await ensureLanguage(highlighter, lang)) ? lang : 'text'
    const html = highlighter.codeToHtml(code, {
      lang: resolved,
      themes: THEMES,
      // Emits both themes as CSS variables on one element instead of picking
      // one at render time. The server cannot know the viewer's theme, and
      // rendering twice to cover both would double the work.
      defaultColor: false,
      transformers: [
        {
          line(node, line) {
            node.properties.id = `L${line}`
            node.properties['data-line'] = String(line)
          },
        },
      ],
    })
    return { html, lang: resolved, lineCount, highlighted: true, reason: null }
  } catch (err) {
    // Shiki failing (a corrupt grammar, an OOM on a pathological file) must
    // not lose the file. Falling back keeps the view working and names the
    // cause instead of showing an empty panel.
    const message = err instanceof Error ? err.message : String(err)
    const plain = plainHtml(code, `Highlighting failed (${message.slice(0, 120)}), so this file is shown as plain text.`)
    return { html: plain.html, lang, lineCount: plain.lineCount, highlighted: false, reason: plain.reason }
  }
}

// ---------------------------------------------------------------------------
// R9.3 — markdown preview

/**
 * Why this neutralises raw HTML at the renderer instead of sanitising after.
 *
 * The obvious move is marked + DOMPurify. DOMPurify 3.4.8 is in the tree
 * (another monaco peer) but it needs a DOM: on the server that means jsdom,
 * jsdom is not installed, and this unit may not install packages. A
 * hand-written regex "sanitiser" over arbitrary HTML is the classic way to
 * ship something that looks safe and is not, so it was rejected outright.
 *
 * Closing the hole at the source is strictly stronger than filtering after
 * it. Markdown's only route to arbitrary HTML is the `html` token — which
 * both the block parser and the inline parser dispatch to `renderer.html`
 * (verified in marked 14.0.0's parser, both `parse` and `parseInline`) — plus
 * the `href`/`src` of links and images. Overriding those three is a complete
 * enumeration of the attack surface, and everything else marked emits is
 * already escaped by its own `text` and `code` renderers.
 *
 * The visible consequence, which is intended: a README containing raw
 * `<div>`s shows them as text rather than rendering them. For a file out of
 * somebody's repository that is the right default.
 */
const SAFE_LINK_PROTOCOL = /^(https?:|mailto:)/i

function renderMarkdownLink(href: string, title: string | null | undefined, inner: string): string {
  const trimmed = (href ?? '').trim()
  if (trimmed.startsWith('#')) {
    // An in-document anchor is the one relative link that actually works here.
    return `<a href="${escapeHtml(trimmed)}">${inner}</a>`
  }
  if (!SAFE_LINK_PROTOCOL.test(trimmed)) {
    // Includes `javascript:` and `data:` (blocked) and repo-relative links
    // (which would resolve against this app's own route and 404). Shown as
    // text so the reader still sees the words, with the target in the title.
    return `<span class="repo-md-inert" title="${escapeHtml(trimmed)}">${inner}</span>`
  }
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(trimmed)}" target="_blank" rel="nofollow noopener noreferrer"${titleAttr}>${inner}</a>`
}

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }) {
      return renderMarkdownLink(href, title, this.parser.parseInline(tokens))
    },
    image({ href, title, text }) {
      const trimmed = (href ?? '').trim()
      if (!/^https?:/i.test(trimmed)) {
        // A repo-relative image would point at a path this app does not
        // serve. Naming the file beats a broken-image icon.
        return `<span class="repo-md-inert">[image: ${escapeHtml(text || trimmed)}]</span>`
      }
      // `referrerpolicy` because a README's badges are third-party hosts and
      // the reader's URL is not theirs to have.
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<img src="${escapeHtml(trimmed)}" alt="${escapeHtml(text ?? '')}"${titleAttr} loading="lazy" referrerpolicy="no-referrer" />`
    },
    code({ text, lang }) {
      // Deliberately not run through shiki. A README holds a dozen fenced
      // blocks in as many languages, and loading a dozen grammars to colour
      // a preview would cost more than the preview is worth.
      const cls = lang ? ` class="language-${escapeHtml(lang.split(/\s+/)[0])}"` : ''
      return `<pre class="repo-md-code"><code${cls}>${escapeHtml(text)}</code></pre>\n`
    },
  },
})

/** Server-rendered, sanitised-by-construction markdown. See the block comment
 * above for why "by construction" rather than by a post-hoc filter. */
export function renderMarkdown(source: string): string {
  return markdown.parse(source, { async: false })
}
