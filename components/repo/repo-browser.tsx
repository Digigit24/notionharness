'use client'

// R9.1 — the browser itself: breadcrumb, ref picker, one directory or one
// file, and nothing else.
//
// Navigation state lives in the URL and is written with the History API
// directly rather than with `router.push`. That is a latency decision, not a
// style one: a Next navigation would re-run the server component for the
// whole project page (tasks, runs, resources, worktrees) to move between two
// directories, when the only thing that changed is one `readRepoView` call.
// `pushState` + a `popstate` listener gives copyable URLs and a working back
// button for the cost of the one call that was needed anyway.
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { AlertTriangle, ChevronRight, FolderGit2, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { RepoCodeStyles } from './repo-code-styles'
import { RepoDirectoryTable } from './repo-directory-table'
import { RepoFileView } from './repo-file-view'
import {
  readRepoStampFor,
  readRepoView,
  type RepoViewPayload,
} from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/files/actions'
import type { RepoEntry } from '@/lib/git/tree'
import { ClientFailure, unwrap, type FailureInfo } from '@/lib/failures'

/** Query-parameter names. Prefixed so they cannot collide with
 * `DetailLayout`'s own `?tab=`, which shares the URL on the project page. */
const PARAMS = { resource: 'fres', ref: 'fref', path: 'fpath', kind: 'fkind', worktree: 'fwt' } as const

/**
 * How often the change poll runs, and only while the page is visible.
 *
 * This is D0's polling exception, used where it was written for: the thing
 * being watched is a git directory on disk with no push channel. It is
 * affordable because `readRepoStampFor` is two `fs.stat` calls and no git
 * process — see its comment. A background tab polls not at all.
 */
const STAMP_POLL_MS = 6_000

interface Position {
  resourceId: number | null
  ref: string | null
  path: string
  kind: 'directory' | 'file'
  worktree: boolean
}

function positionFromView(view: RepoViewPayload): Position {
  return {
    resourceId: view.binding.resourceId,
    ref: view.kind === 'file' ? view.blob.ref : view.listing.ref,
    path: view.kind === 'file' ? view.blob.path : view.listing.path,
    kind: view.kind,
    worktree: view.kind === 'file' && view.blob.source === 'worktree',
  }
}

function positionFromLocation(fallback: Position): Position {
  const params = new URLSearchParams(window.location.search)
  const resource = Number(params.get(PARAMS.resource))
  return {
    resourceId: Number.isFinite(resource) && resource > 0 ? resource : fallback.resourceId,
    ref: params.get(PARAMS.ref) || fallback.ref,
    path: params.get(PARAMS.path) ?? '',
    kind: params.get(PARAMS.kind) === 'file' ? 'file' : 'directory',
    worktree: params.get(PARAMS.worktree) === '1',
  }
}

function lineFromHash(): number | null {
  const match = /^#L(\d+)$/.exec(window.location.hash)
  if (!match) return null
  const line = Number(match[1])
  return Number.isFinite(line) && line > 0 ? line : null
}

function writeUrl(position: Position, line: number | null, mode: 'push' | 'replace') {
  const url = new URL(window.location.href)
  const set = (key: string, value: string | null) => {
    if (value) url.searchParams.set(key, value)
    else url.searchParams.delete(key)
  }
  set(PARAMS.resource, position.resourceId === null ? null : String(position.resourceId))
  set(PARAMS.ref, position.ref)
  set(PARAMS.path, position.path || null)
  set(PARAMS.kind, position.kind === 'file' ? 'file' : null)
  set(PARAMS.worktree, position.worktree ? '1' : null)
  url.hash = line === null ? '' : `L${line}`
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url.toString())
}

/**
 * What to show for something that was thrown.
 *
 * `unwrap` re-throws a returned failure as a `ClientFailure` created HERE in
 * the browser, so its message and detail are the server's own — unlike a
 * server action that throws, whose message React replaces with a digest.
 */
function toFailureLine(err: unknown): FailureInfo {
  if (err instanceof ClientFailure) {
    return { code: err.code, message: err.message, detail: err.detail, retryable: err.retryable }
  }
  return {
    code: 'unknown',
    message: err instanceof Error ? err.message : 'That could not be read.',
    retryable: false,
  }
}

export function RepoBrowser({
  workspaceSlug,
  projectId,
  initialView,
  initialError,
  variant = 'page',
}: {
  workspaceSlug: string
  projectId: number
  /** Rendered on the server for the dedicated route, so a deep link paints
   * highlighted with no client round trip. Null inside the project detail
   * tab, where the tab body is a client component and there is no server
   * boundary to hand one down — that case fetches on mount instead. */
  initialView: RepoViewPayload | null
  /** A server-side failure to report instead of an empty panel. The whole
   * failure, not just its sentence: git's stderr is the line that says which
   * of the six git problems this is. */
  initialError?: FailureInfo | null
  variant?: 'page' | 'tab'
}) {
  const [view, setView] = useState<RepoViewPayload | null>(initialView)
  const [error, setError] = useState<FailureInfo | null>(initialError ?? null)
  const [pending, startTransition] = useTransition()
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [line, setLine] = useState<number | null>(null)

  // The position the last successful load was for. A ref rather than state
  // because the poll and the popstate listener both read it and neither
  // should re-subscribe when it changes.
  const positionRef = useRef<Position>(
    initialView
      ? positionFromView(initialView)
      : { resourceId: null, ref: null, path: '', kind: 'directory', worktree: false },
  )
  const stampRef = useRef<string | null>(initialView?.stamp ?? null)

  const load = useCallback(
    (position: Position, options: { line?: number | null; url?: 'push' | 'replace' | 'none' } = {}) => {
      positionRef.current = position
      setBusyPath(position.path || null)
      setError(null)
      startTransition(async () => {
        try {
          const next = unwrap(
            await readRepoView({
              workspaceSlug,
              projectId,
              resourceId: position.resourceId,
              ref: position.ref,
              path: position.path,
              kind: position.kind,
              worktree: position.worktree,
            }),
          )
          setView(next)
          stampRef.current = next.stamp
          positionRef.current = positionFromView(next)
          if (options.line !== undefined) setLine(options.line)
          if (options.url && options.url !== 'none') {
            writeUrl(positionRef.current, options.line ?? null, options.url)
          }
        } catch (err) {
          setError(toFailureLine(err))
        } finally {
          setBusyPath(null)
        }
      })
    },
    [projectId, workspaceSlug],
  )

  // First load for the tab variant, and hash pickup for both. `initialView`
  // being present means the server already did this work, so nothing fires.
  useEffect(() => {
    setLine(lineFromHash())
    if (initialView) return
    load(positionFromLocation(positionRef.current), { url: 'none' })
    // Intentionally mount-only: re-running this on every `load` identity
    // change would refetch the root over whatever the user had opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Back and forward. `pushState` gives us the entries; this is what makes
  // them mean something.
  useEffect(() => {
    const onPop = () => {
      setLine(lineFromHash())
      load(positionFromLocation(positionRef.current), { url: 'none' })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [load])

  // R9.5's "reflects an external commit within one poll".
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      timer = null
      if (cancelled || document.visibilityState !== 'visible') return schedule()
      try {
        const stamp = unwrap(
          await readRepoStampFor({
            workspaceSlug,
            projectId,
            resourceId: positionRef.current.resourceId,
          }),
        )
        if (!cancelled && stampRef.current !== null && stamp !== stampRef.current) {
          stampRef.current = stamp
          load(positionRef.current, { url: 'none' })
        }
      } catch {
        // A repository that has gone away is already reported by the next
        // real navigation; a failing poll must not put an error banner on a
        // page the user is reading.
      }
      schedule()
    }
    const schedule = () => {
      if (!cancelled && timer === null) timer = setTimeout(tick, STAMP_POLL_MS)
    }

    // Coming back to the tab should not wait out the interval.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && timer !== null) {
        clearTimeout(timer)
        timer = null
        void tick()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    schedule()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load, projectId, workspaceSlug])

  const open = useCallback(
    (entry: RepoEntry) => {
      if (entry.type === 'commit') return
      const position: Position = {
        ...positionRef.current,
        path: entry.path,
        kind: entry.type === 'blob' ? 'file' : 'directory',
        // An untracked file has no blob at any ref, so the only copy that
        // exists is the one on disk. Selecting the working tree for it is not
        // a preference, it is the only readable source.
        worktree: entry.status === 'untracked',
      }
      load(position, { line: null, url: 'push' })
    },
    [load],
  )

  const goToPath = useCallback(
    (path: string) => load({ ...positionRef.current, path, kind: 'directory', worktree: false }, { line: null, url: 'push' }),
    [load],
  )

  const current = positionRef.current
  const segments = (view ? (view.kind === 'file' ? view.blob.path : view.listing.path) : current.path)
    .split('/')
    .filter(Boolean)

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', variant === 'page' ? 'p-6' : 'p-4')}>
      <RepoCodeStyles />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FolderGit2 className="h-4 w-4 shrink-0 text-black/40 dark:text-white/40" />
        {view && view.bindings.length > 1 ? (
          <select
            value={view.binding.resourceId}
            onChange={(event) =>
              load(
                { resourceId: Number(event.target.value), ref: null, path: '', kind: 'directory', worktree: false },
                { line: null, url: 'push' },
              )
            }
            className="rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs dark:border-white/15"
          >
            {view.bindings.map((binding) => (
              <option key={binding.resourceId} value={binding.resourceId}>
                {binding.name}
              </option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            onClick={() => goToPath('')}
            className="font-medium hover:underline"
            title={view?.binding.path}
          >
            {view?.binding.name ?? 'Repository'}
          </button>
        )}

        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1
          const path = segments.slice(0, index + 1).join('/')
          return (
            <span key={path} className="flex items-center gap-2">
              <ChevronRight className="h-3.5 w-3.5 text-black/25 dark:text-white/25" />
              {isLast ? (
                <span className="font-mono text-[13px]">{segment}</span>
              ) : (
                <button type="button" onClick={() => goToPath(path)} className="font-mono text-[13px] hover:underline">
                  {segment}
                </button>
              )}
            </span>
          )
        })}

        <div className="ml-auto flex items-center gap-2">
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-black/40 dark:text-white/40" />}
          {view && (
            <select
              value={view.kind === 'file' ? view.blob.ref : view.listing.ref}
              onChange={(event) => load({ ...positionRef.current, ref: event.target.value }, { url: 'replace' })}
              className="rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs dark:border-white/15"
              title="Branch or ref"
            >
              {view.refs.map((ref) => (
                <option key={ref.name} value={ref.name}>
                  {ref.name}
                  {ref.current ? ' (current)' : ''}
                </option>
              ))}
            </select>
          )}
          {view?.kind === 'file' && (
            // Only offered for a file, and only meaningful when the working
            // tree differs. Reading from disk is the one read here that is
            // never cached, which is why it is opt-in rather than the default.
            <button
              type="button"
              onClick={() =>
                load({ ...positionRef.current, worktree: !positionRef.current.worktree }, { url: 'replace' })
              }
              className={cn(
                'rounded-md border px-2 py-1 text-xs',
                view.blob.source === 'worktree'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'border-black/10 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]',
              )}
              title="Read this file from the working tree instead of the selected ref"
            >
              Working tree
            </button>
          )}
          <button
            type="button"
            onClick={() => load(positionRef.current, { url: 'none' })}
            className="rounded-md border border-black/10 p-1.5 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
            title="Reload"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error.message}
          </p>
          {/* git's own stderr, and the single most useful string on this
              screen: "not a git repository", "unknown revision" and "spawn
              git ENOENT" are three different fixes and the sentence above
              cannot say which. Secondary rather than hidden — it is what you
              read second, and only if the first line was not enough. */}
          {error.detail && (
            <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words pl-[1.375rem] font-mono text-[11px] leading-relaxed text-red-600/70 dark:text-red-400/70">
              {error.detail}
            </pre>
          )}
        </div>
      )}

      {view?.kind === 'directory' && (
        <RepoDirectoryTable
          entries={view.listing.entries}
          truncated={view.listing.truncated}
          totalEntries={view.listing.totalEntries}
          onOpen={open}
          onUp={view.listing.path ? () => goToPath(view.listing.path.split('/').slice(0, -1).join('/')) : null}
          busyPath={busyPath}
        />
      )}

      {view?.kind === 'file' && (
        <div
          className={cn(
            'overflow-hidden rounded-lg border border-black/10 dark:border-white/10',
            variant === 'page' ? 'max-h-[calc(100vh-14rem)]' : 'max-h-[70vh]',
          )}
        >
          <RepoFileView
            payload={view}
            initialLine={line}
            onLineSelected={(next) => {
              setLine(next)
              // Replace, not push: selecting a line is a bookmark, and making
              // every click a history entry turns Back into "undo the last
              // twelve line clicks".
              writeUrl(positionRef.current, next, 'replace')
            }}
          />
        </div>
      )}

      {!view && !error && (
        <p className="px-1 py-6 text-sm text-black/45 dark:text-white/45">Reading the repository…</p>
      )}
    </div>
  )
}
