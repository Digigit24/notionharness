'use client'

// R9.2/R9.3 — one file.
//
// This component renders HTML it did not produce. The highlighting, the
// markdown and the escaping all happened on the server (see
// lib/git/highlight.ts); what arrives here is already-safe markup, and the
// only reason `dangerouslySetInnerHTML` appears is that there is no other way
// to mount a server-rendered string. Nothing in this file parses, transforms
// or re-sanitises that markup — doing any of those in the browser is exactly
// the render-path cost the server work exists to avoid.
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Binary, Code2, Eye, FileWarning } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes } from './repo-directory-table'
import type { RepoFilePayload } from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/files/actions'

type PreviewMode = 'code' | 'preview'

export function RepoFileView({
  payload,
  /** Line to reveal on arrival, from a `#L42` deep link. */
  initialLine,
  onLineSelected,
}: {
  payload: RepoFilePayload
  initialLine: number | null
  onLineSelected: (line: number | null) => void
}) {
  const { blob, code, markdownHtml, htmlPreview } = payload
  const hasPreview = markdownHtml !== null || htmlPreview !== null
  // A README opens as a document and source code opens as source. Both are
  // one click from the other; guessing wrong costs a click, not a reload.
  const [mode, setMode] = useState<PreviewMode>(hasPreview ? 'preview' : 'code')
  const [line, setLine] = useState<number | null>(initialLine)
  const codeRef = useRef<HTMLDivElement | null>(null)

  // Reset when the file changes — without this, opening a second file keeps
  // the first one's tab and line selection.
  useEffect(() => {
    setMode(hasPreview ? 'preview' : 'code')
    setLine(initialLine)
  }, [blob.path, blob.ref, blob.source, hasPreview, initialLine])

  // Paint the deep-linked line and bring it into view. Runs against the DOM
  // the server-rendered HTML produced, because that markup carries `id="L42"`
  // and `data-line` on every line and there is no React tree to key off.
  useEffect(() => {
    const root = codeRef.current
    if (!root) return
    for (const el of root.querySelectorAll('.line.is-linked')) el.classList.remove('is-linked')
    if (line === null || mode !== 'code') return
    const target = root.querySelector<HTMLElement>(`.line[data-line="${line}"]`)
    if (!target) return
    target.classList.add('is-linked')
    target.scrollIntoView({ block: 'center' })
  }, [line, mode, code?.html])

  /**
   * Clicking a line number selects the line.
   *
   * One listener on the container rather than a handler per line: the line
   * numbers are `::before` pseudo-elements with no DOM node of their own, so
   * there is nothing per-line to attach to — and adding real nodes for them
   * would put 5,000 extra elements on the page to make them clickable. The
   * click is attributed to the gutter by comparing the pointer's x against
   * the line box's left edge plus the gutter width.
   */
  const onCodeClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('.line')
      if (!el) return
      const gutter = parseFloat(getComputedStyle(el).getPropertyValue('--repo-gutter')) || 52
      const box = el.getBoundingClientRect()
      if (event.clientX - box.left > gutter) return
      const next = Number(el.dataset.line)
      if (!Number.isFinite(next)) return
      const value = next === line ? null : next
      setLine(value)
      onLineSelected(value)
    },
    [line, onLineSelected],
  )

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-black/10 px-3 py-2 text-xs text-black/55 dark:border-white/10 dark:text-white/55">
        <span className="font-mono">{formatBytes(blob.size)}</span>
        {code && <span>{code.lineCount.toLocaleString()} lines</span>}
        {code && <span className="font-mono">{code.lang}</span>}
        {blob.source === 'worktree' && (
          <span className="text-amber-600 dark:text-amber-400">working tree copy</span>
        )}
        {hasPreview && (
          <div className="ml-auto flex items-center gap-1 rounded-md border border-black/10 p-0.5 dark:border-white/10">
            <ModeButton active={mode === 'preview'} onClick={() => setMode('preview')} icon={<Eye className="h-3.5 w-3.5" />}>
              Preview
            </ModeButton>
            <ModeButton active={mode === 'code'} onClick={() => setMode('code')} icon={<Code2 className="h-3.5 w-3.5" />}>
              Source
            </ModeButton>
          </div>
        )}
      </div>

      {blob.tooLarge ? (
        <Notice
          icon={<FileWarning className="h-4 w-4" />}
          title="This file is too large to display"
          detail={`${formatBytes(blob.size)}. Files over 1 MB are described rather than rendered — reading one into a page costs more than it is worth.`}
        />
      ) : blob.binary ? (
        // R9.3: "images and binaries state what they are and how large they
        // are". That is the finished behaviour, not a missing feature — a
        // preview surface that grows one file type at a time is how this
        // turns into a file manager nobody asked for.
        <Notice
          icon={<Binary className="h-4 w-4" />}
          title="Binary file"
          detail={`${formatBytes(blob.size)}. This file contains NUL bytes within its first 8 KB, so it is not text.`}
        />
      ) : mode === 'preview' && markdownHtml !== null ? (
        <div className="repo-md max-w-3xl px-4 py-4" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
      ) : mode === 'preview' && htmlPreview !== null ? (
        <HtmlPreview source={htmlPreview} />
      ) : code ? (
        <>
          {code.reason && (
            <p className="border-b border-black/5 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-700 dark:border-white/10 dark:text-amber-400">
              {code.reason}
            </p>
          )}
          <div
            ref={codeRef}
            className="repo-code min-h-0 flex-1 overflow-auto"
            onClick={onCodeClick}
            dangerouslySetInnerHTML={{ __html: code.html }}
          />
        </>
      ) : (
        <Notice icon={<FileWarning className="h-4 w-4" />} title="Nothing to show" detail="This file has no readable content." />
      )}
    </div>
  )
}

/**
 * R9.3 — an HTML file, contained.
 *
 * `sandbox=""` with no tokens is the strictest setting there is: the document
 * gets an opaque origin (so no same-origin access to this app, no cookies, no
 * localStorage), scripts do not run, forms do not submit, and it cannot
 * navigate the top-level page. `srcdoc` keeps the bytes out of any URL, and
 * `referrerpolicy` stops the app's own URL leaking to anything the document
 * tries to load.
 *
 * The honest caveat: R9.3 asks for "ideally from a separate origin", and this
 * is an opaque origin rather than a separate host. With `allow-same-origin`
 * absent that is equivalent for everything this needs to stop; serving it
 * from a distinct hostname would additionally defend against a browser bug in
 * sandbox enforcement, and that would need infrastructure this unit does not
 * own.
 */
function HtmlPreview({ source }: { source: string }) {
  return (
    <div className="p-3">
      <iframe
        title="HTML preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={source}
        className="h-[70vh] w-full rounded-md border border-black/10 bg-white dark:border-white/10"
      />
      <p className="pt-2 text-xs text-black/45 dark:text-white/45">
        Rendered in a sandbox with scripts disabled and no access to this app.
      </p>
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded px-2 py-1 text-xs',
        active ? 'bg-black/[.06] text-black dark:bg-white/[.10] dark:text-white' : 'hover:bg-black/[.03] dark:hover:bg-white/[.05]',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function Notice({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="flex size-9 items-center justify-center rounded-full bg-black/[.05] text-black/50 dark:bg-white/[.08] dark:text-white/50">
        {icon}
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-black/50 dark:text-white/50">{detail}</p>
    </div>
  )
}
