// R9.1/R9.2 — the CSS the server-rendered markup needs.
//
// This is a `<style>` element rather than a block in `app/globals.css` for
// two reasons. It belongs to this feature and nothing else loads it; and
// globals.css is outside this unit's owned paths. Rendering it inside the
// browser means the rules ship only on the pages that use them.
//
// Two things here are load-bearing rather than decoration:
//
//  - The line gutter is `content: attr(data-line)` on a `::before`. That is
//    why line numbers cost no DOM at all on a 5,000-line file, and why
//    selecting a block of code copies the code without the numbers. The
//    pseudo-element is `position: sticky; left: 0` so it stays put when a
//    long line scrolls the `<pre>` sideways.
//  - Colours come from shiki's dual-theme CSS variables. The server renders
//    once, with both palettes attached as `--shiki-light` / `--shiki-dark`,
//    and the `.dark` class picks one. Rendering twice to cover both themes
//    would double the server's work for something a variable does for free.

const CSS = `
.repo-code {
  /* In px, not rem: the click handler in repo-file-view.tsx reads this
     value with parseFloat to tell a gutter click from a code click, and a
     rem value would parse to the wrong number. */
  --repo-gutter: 52px;
  background: var(--card);
  color: var(--card-foreground);
  font-size: 12.5px;
  line-height: 1.6;
  overflow: hidden;
}
.repo-code pre.shiki {
  margin: 0;
  padding: 12px 0;
  overflow-x: auto;
  background: transparent !important;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  tab-size: 2;
}
.repo-code pre.shiki code {
  display: block;
  width: max-content;
  min-width: 100%;
  font: inherit;
}
.repo-code .line {
  display: block;
  padding-right: 1rem;
  min-height: 1.6em;
}
.repo-code .line::before {
  content: attr(data-line);
  display: inline-block;
  position: sticky;
  left: 0;
  width: var(--repo-gutter);
  padding-right: 0.85rem;
  margin-right: 0.35rem;
  box-sizing: border-box;
  text-align: right;
  color: color-mix(in oklab, var(--card-foreground) 38%, transparent);
  background: var(--card);
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.repo-code .line:hover::before {
  color: color-mix(in oklab, var(--card-foreground) 75%, transparent);
}
/* The deep-link target. \`:target\` covers arriving with #L42 in the URL;
   \`.is-linked\` covers clicking a line number once the page is already open,
   where the hash changes but :target does not always re-match after a
   client-side render. */
.repo-code .line:target,
.repo-code .line.is-linked {
  background: color-mix(in oklab, var(--primary) 14%, transparent);
}
.repo-code .line:target::before,
.repo-code .line.is-linked::before {
  background: color-mix(in oklab, var(--primary) 14%, var(--card));
  color: var(--card-foreground);
}
.repo-code .shiki,
.repo-code .shiki span {
  color: var(--shiki-light);
}
.dark .repo-code .shiki,
.dark .repo-code .shiki span {
  color: var(--shiki-dark);
}

/* Markdown preview (R9.3). Deliberately plain: this is a preview of a file,
   not a document surface. */
.repo-md {
  font-size: 14px;
  line-height: 1.7;
  color: var(--card-foreground);
  word-wrap: break-word;
}
.repo-md > *:first-child { margin-top: 0; }
.repo-md h1, .repo-md h2, .repo-md h3, .repo-md h4 {
  font-weight: 600;
  line-height: 1.3;
  margin: 1.6em 0 0.6em;
}
.repo-md h1 { font-size: 1.6em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
.repo-md h2 { font-size: 1.3em; padding-bottom: 0.25em; border-bottom: 1px solid var(--border); }
.repo-md h3 { font-size: 1.1em; }
.repo-md p, .repo-md ul, .repo-md ol, .repo-md blockquote, .repo-md table { margin: 0 0 1em; }
.repo-md ul, .repo-md ol { padding-left: 1.6em; }
.repo-md ul { list-style: disc; }
.repo-md ol { list-style: decimal; }
.repo-md li { margin: 0.2em 0; }
.repo-md a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.repo-md code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 0.88em;
  background: color-mix(in oklab, var(--card-foreground) 8%, transparent);
  border-radius: 4px;
  padding: 0.15em 0.35em;
}
.repo-md pre.repo-md-code {
  background: color-mix(in oklab, var(--card-foreground) 6%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
  margin: 0 0 1em;
}
.repo-md pre.repo-md-code code { background: none; padding: 0; font-size: 12.5px; }
.repo-md blockquote {
  border-left: 3px solid var(--border);
  padding-left: 1em;
  color: color-mix(in oklab, var(--card-foreground) 65%, transparent);
}
.repo-md table { border-collapse: collapse; display: block; overflow-x: auto; }
.repo-md th, .repo-md td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
.repo-md th { font-weight: 600; background: color-mix(in oklab, var(--card-foreground) 5%, transparent); }
.repo-md hr { border: 0; border-top: 1px solid var(--border); margin: 1.6em 0; }
.repo-md img { max-width: 100%; }
/* A link or image markdown asked for that we would not render live — see
   \`renderMarkdown\` in lib/git/highlight.ts. Shown as text, not hidden. */
.repo-md .repo-md-inert {
  color: color-mix(in oklab, var(--card-foreground) 60%, transparent);
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}
`

export function RepoCodeStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />
}
