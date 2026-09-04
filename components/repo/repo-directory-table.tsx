'use client'

// R9.1 — "a breadcrumb and a flat table of one directory".
//
// No file-manager library, and no tree component either. GitHub's own browser
// is exactly this — one directory at a time, a breadcrumb above it — and the
// reason is not aesthetic: a persistent tree has to decide what to load and
// when, and gets it wrong on a repository with a large `node_modules`. A flat
// table of the directory you asked for cannot.
import { ChevronRight, File, FileSymlink, Folder, GitCommitHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RepoEntry, RepoEntryStatus } from '@/lib/git/tree'

/** Human byte sizes. Local rather than imported: the one other copy in the
 * app lives inside a client component for agent skills and pulling it here
 * would couple two unrelated features. */
export function formatBytes(value: number | null): string {
  if (value === null) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const STATUS_LABELS: Record<RepoEntryStatus, string> = {
  modified: 'Modified',
  staged: 'Staged',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Conflicted',
  untracked: 'Untracked',
  'contains-changes': 'Changes inside',
}

const STATUS_CLASSES: Record<RepoEntryStatus, string> = {
  modified: 'text-amber-600 dark:text-amber-400',
  staged: 'text-emerald-600 dark:text-emerald-400',
  added: 'text-emerald-600 dark:text-emerald-400',
  deleted: 'text-red-600 dark:text-red-400',
  renamed: 'text-sky-600 dark:text-sky-400',
  conflicted: 'text-red-600 dark:text-red-400',
  untracked: 'text-black/45 dark:text-white/45',
  'contains-changes': 'text-black/45 dark:text-white/45',
}

export function RepoDirectoryTable({
  entries,
  truncated,
  totalEntries,
  onOpen,
  onUp,
  busyPath,
}: {
  entries: RepoEntry[]
  truncated: boolean
  totalEntries: number
  onOpen: (entry: RepoEntry) => void
  /** Absent at the repository root, which is what makes ".." not appear there. */
  onUp: (() => void) | null
  /** The row the user just clicked, so the wait is attributed to the thing
   * they clicked instead of blanking the whole table. */
  busyPath: string | null
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
      <table className="w-full table-fixed text-sm">
        <tbody className="divide-y divide-black/5 dark:divide-white/10">
          {onUp && (
            <tr>
              <td colSpan={3} className="p-0">
                <button
                  type="button"
                  onClick={onUp}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/[.03] dark:hover:bg-white/[.04]"
                >
                  <Folder className="h-4 w-4 shrink-0 text-black/40 dark:text-white/40" />
                  <span className="font-mono text-[13px] text-black/60 dark:text-white/60">..</span>
                </button>
              </td>
            </tr>
          )}
          {entries.map((entry) => {
            const isDir = entry.type === 'tree'
            return (
              <tr key={entry.path} className={cn(busyPath === entry.path && 'opacity-50')}>
                <td className="p-0">
                  <button
                    type="button"
                    onClick={() => onOpen(entry)}
                    // A submodule is a commit pointer, not a tree we can list.
                    disabled={entry.type === 'commit'}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/[.03] disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-white/[.04]"
                    title={entry.path}
                  >
                    {entry.type === 'commit' ? (
                      <GitCommitHorizontal className="h-4 w-4 shrink-0 text-black/40 dark:text-white/40" />
                    ) : entry.type === 'symlink' ? (
                      <FileSymlink className="h-4 w-4 shrink-0 text-violet-600/70 dark:text-violet-400/70" />
                    ) : isDir ? (
                      <Folder className="h-4 w-4 shrink-0 text-sky-600/70 dark:text-sky-400/70" />
                    ) : (
                      <File className="h-4 w-4 shrink-0 text-black/35 dark:text-white/35" />
                    )}
                    <span className="truncate font-mono text-[13px]">{entry.name}</span>
                    {isDir && (
                      <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-black/25 dark:text-white/25" />
                    )}
                  </button>
                </td>
                <td className="w-28 whitespace-nowrap px-3 text-right text-xs">
                  {entry.status && (
                    <span className={STATUS_CLASSES[entry.status]}>{STATUS_LABELS[entry.status]}</span>
                  )}
                </td>
                <td className="w-20 whitespace-nowrap px-3 text-right font-mono text-xs text-black/40 dark:text-white/40">
                  {entry.type === 'blob'
                    ? formatBytes(entry.size)
                    : entry.type === 'commit'
                      ? 'submodule'
                      : entry.type === 'symlink'
                        ? 'symlink'
                        : ''}
                </td>
              </tr>
            )
          })}
          {entries.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-6 text-center text-sm text-black/45 dark:text-white/45">
                This directory is empty at this ref.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {truncated && (
        // Stated, not silently dropped: a directory with 40,000 entries is a
        // real thing and pretending it has 1,000 would be a lie the user
        // cannot see.
        <p className="border-t border-black/5 px-3 py-2 text-xs text-black/45 dark:border-white/10 dark:text-white/45">
          Showing {entries.length.toLocaleString()} of {totalEntries.toLocaleString()} entries. The rest are not listed.
        </p>
      )}
    </div>
  )
}
