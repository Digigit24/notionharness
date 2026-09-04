'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  CheckCircle2,
  FolderGit2,
  GitBranch,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatRelativeTime } from '@/lib/relative-time'
import { ClientFailure, unwrap } from '@/lib/failures'
import {
  addGitHubResource,
  addLocalResource,
  createProjectWorktree,
  removeProjectWorktree,
  type ProjectGitOverview,
} from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/worktree-actions'

/**
 * A project's git bindings and its worktrees.
 *
 * Two facts drive the whole layout. A project can bind several repositories
 * AND several plain folders, so bindings are a list rather than a single
 * field. And a worktree only exists inside a git repository, so the
 * "New worktree" control is offered per repository binding and simply absent
 * on a folder — which is more honest than a disabled button with a tooltip.
 */
export function ProjectWorktreesTab({
  workspaceSlug,
  projectId,
  overview,
  compact = false,
}: {
  workspaceSlug: string
  projectId: number
  overview: ProjectGitOverview
  /** Rendered in the detail page's right rail rather than as a full tab:
   * drops the page padding and the max-width, which exist for a tab body and
   * would waste most of a 320px column. */
  compact?: boolean
}) {
  const router = useRouter()
  const [resources, setResources] = useState(overview.resources)
  // Mirrors `overview.worktrees`/`overview.statuses` so creating or removing
  // a worktree shows up the instant that git operation itself finishes,
  // instead of ALSO waiting on `router.refresh()`'s full server round trip
  // on top of it (D0) — the git op is real, unavoidable latency; the refresh
  // used to be a second one stacked on it. Resynced on a fresh `overview`
  // (a background refresh landing, or the page reloading).
  const [worktrees, setWorktrees] = useState(overview.worktrees)
  const [statuses, setStatuses] = useState(overview.statuses)
  useEffect(() => {
    setResources(overview.resources)
    setWorktrees(overview.worktrees)
    setStatuses(overview.statuses)
  }, [overview])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, startBackgroundRefresh] = useTransition()

  const [localPath, setLocalPath] = useState('')
  const [ghRepo, setGhRepo] = useState('')
  const [newName, setNewName] = useState('')
  const [newResourceId, setNewResourceId] = useState<number | null>(
    overview.resources.find((r) => r.isRepo)?.id ?? null,
  )
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)
  // P5.6 — the confirm affordance below is only useful if it says WHAT will
  // be discarded, not just that a decision is needed. git's own stderr
  // (surfaced as the failure's `detail`) names the files; this is what
  // renders it next to "Discard & remove" instead of a bare pair of buttons.
  const [dirtyWarning, setDirtyWarning] = useState<string | null>(null)

  const repoResources = resources.filter((r) => r.isRepo)
  // Derived rather than stored: the picker's initial value was computed at
  // mount, when this project had no bindings yet, so binding the first
  // repository left the selection empty and the create button dead. Falling
  // back to the first repository keeps it usable the moment one exists.
  const selectedResourceId = newResourceId ?? repoResources[0]?.id ?? null

  // `work` is expected to have already updated whichever local state it
  // touched (resources/worktrees/statuses) with the server's own returned
  // data before resolving — see each call site below. `router.refresh()`
  // here is therefore purely a BACKGROUND sync (this worktree's live git
  // status, and the Files tab's visibility, which the parent computes from
  // its own separate `gitOverview` prop) — run in its own transition so it
  // never extends `busy` past the point the paint above already landed.
  const run = async (work: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await work()
      startBackgroundRefresh(() => router.refresh())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={compact ? 'space-y-3' : 'space-y-6'}>
      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Bindings</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Repositories and folders this project works in, on the machine running Hermes. A repository can host
          worktrees; a plain folder is worked in directly.
        </p>

        {resources.length === 0 && (
          <p className="mt-3 text-xs text-black/40 dark:text-white/40">Nothing bound yet.</p>
        )}

        <ul className="mt-3 space-y-1.5">
          {resources.map((resource) => (
            <li
              key={resource.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-black/10 px-2.5 py-2 dark:border-white/10"
            >
              {resource.isRepo ? (
                <GitBranch size={13} className="shrink-0 text-black/40 dark:text-white/40" />
              ) : (
                <FolderGit2 size={13} className="shrink-0 text-black/40 dark:text-white/40" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11px]">{resource.path}</span>
                <span className="block text-[10px] text-black/40 dark:text-white/40">
                  {resource.isRepo ? 'git repository' : 'folder'}
                  {resource.defaultBranch ? ` · base ${resource.defaultBranch}` : ''}
                  {` · ${resource.role}`}
                </span>
              </span>
              {!resource.exists && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                  <AlertTriangle size={11} />
                  missing on disk
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-xs font-medium">Bind a local folder</h3>
            <p className="mt-0.5 text-[11px] text-black/45 dark:text-white/45">
              An absolute path on the Hermes machine. If it is a git repository, it is recorded as one.
            </p>
            <div className="mt-2 flex gap-1.5">
              <input
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder={String.raw`E:\work\my-repo`}
                className="min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !localPath.trim()}
                onClick={() =>
                  run(async () => {
                    setResources(unwrap(await addLocalResource({ workspaceSlug, projectId, path: localPath.trim() })))
                    setLocalPath('')
                  })
                }
              >
                Bind
              </Button>
            </div>
          </div>

          <div>
            <h3 className="flex items-center gap-1.5 text-xs font-medium">
              <GitBranch size={12} />
              Clone from GitHub
            </h3>
            <p className="mt-0.5 text-[11px] text-black/45 dark:text-white/45">
              {overview.gh.authenticated
                ? `Using the GitHub CLI${overview.gh.account ? ` as ${overview.gh.account}` : ''}.`
                : overview.gh.installed
                  ? 'Not signed in. Run `gh auth login` on this machine first.'
                  : 'The GitHub CLI (gh) is not installed on this machine.'}
            </p>
            <div className="mt-2 flex gap-1.5">
              <input
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                placeholder="owner/name"
                disabled={!overview.gh.authenticated}
                className="min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-black/25 disabled:opacity-50 dark:border-white/10 dark:focus:border-white/25"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !ghRepo.trim() || !overview.gh.authenticated}
                onClick={() =>
                  run(async () => {
                    setResources(unwrap(await addGitHubResource({ workspaceSlug, projectId, repo: ghRepo.trim() })))
                    setGhRepo('')
                  })
                }
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : null}
                Clone
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Worktrees</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          An isolated checkout on its own branch. A conversation bound to one runs inside it, so its edits land
          where you can see them.
        </p>

        {repoResources.length === 0 ? (
          <p className="mt-3 text-xs text-black/40 dark:text-white/40">
            Bind a git repository first — a plain folder cannot have worktrees.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="What is this branch for?"
              className="w-56 rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
            />
            <Select
              value={selectedResourceId != null ? String(selectedResourceId) : undefined}
              onValueChange={(v) => setNewResourceId(Number(v))}
            >
              <SelectTrigger size="sm" className="w-64 text-xs">
                <SelectValue placeholder="Repository" />
              </SelectTrigger>
              <SelectContent>
                {repoResources.map((resource) => (
                  <SelectItem key={resource.id} value={String(resource.id)}>
                    {resource.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={busy || !newName.trim() || selectedResourceId == null}
              onClick={() =>
                run(async () => {
                  const created = unwrap(
                    await createProjectWorktree({
                      workspaceSlug,
                      projectId,
                      resourceId: selectedResourceId!,
                      name: newName.trim(),
                    }),
                  )
                  setWorktrees((current) => [...current, created])
                  setNewName('')
                })
              }
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              New worktree
            </Button>
          </div>
        )}

        {worktrees.length === 0 && (
          <p className="mt-3 text-xs text-black/40 dark:text-white/40">No worktrees yet.</p>
        )}

        <ul className="mt-3 space-y-1.5">
          {worktrees.map((worktree) => {
            const status = statuses[worktree.id]
            return (
              <li
                key={worktree.id}
                className="rounded-md border border-black/10 px-2.5 py-2 dark:border-white/10"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <GitBranch size={13} className="mt-0.5 shrink-0 text-black/40 dark:text-white/40" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-medium">
                        {worktree.displayName || worktree.branch}
                      </span>
                      <span className="rounded border border-black/10 px-1 font-mono text-[10px] text-black/50 dark:border-white/10 dark:text-white/50">
                        {worktree.branch}
                      </span>
                      <span className="text-[10px] text-black/35 dark:text-white/35">
                        from {worktree.baseRef} · {formatRelativeTime(worktree.lastActivityAt)}
                      </span>
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-black/40 dark:text-white/40">
                      {worktree.path}
                    </p>
                    <p className="mt-1 text-[11px]">
                      {status === null || status === undefined ? (
                        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          <AlertTriangle size={11} />
                          Not readable on disk
                        </span>
                      ) : status.clean ? (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 size={11} />
                          Clean
                          {status.ahead > 0 ? ` · ${status.ahead} ahead` : ''}
                          {status.behind > 0 ? ` · ${status.behind} behind` : ''}
                        </span>
                      ) : (
                        <span className="text-black/60 dark:text-white/60">
                          {status.changes.length} changed
                          {status.ahead > 0 ? ` · ${status.ahead} ahead` : ''}
                          {status.behind > 0 ? ` · ${status.behind} behind` : ''}
                        </span>
                      )}
                    </p>
                    {confirmRemove === worktree.id && dirtyWarning && (
                      <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                        <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                        <span className="whitespace-pre-wrap">{dirtyWarning}</span>
                      </p>
                    )}
                  </div>

                  {confirmRemove === worktree.id ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            unwrap(
                              await removeProjectWorktree({
                                workspaceSlug,
                                projectId,
                                worktreeId: worktree.id,
                                force: true,
                                deleteBranch: true,
                              }),
                            )
                            setWorktrees((current) => current.filter((w) => w.id !== worktree.id))
                            setConfirmRemove(null)
                            setDirtyWarning(null)
                          })
                        }
                      >
                        Discard &amp; remove
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setConfirmRemove(null)
                          setDirtyWarning(null)
                        }}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          try {
                            unwrap(await removeProjectWorktree({ workspaceSlug, projectId, worktreeId: worktree.id }))
                            setWorktrees((current) => current.filter((w) => w.id !== worktree.id))
                          } catch (err) {
                            // A dirty worktree needs an explicit decision, so
                            // escalate to the confirm affordance rather than
                            // just reporting a failure. R12-P1.1 makes that
                            // branch on the failure's CODE rather than on a
                            // regex over its sentence — the sentence is written
                            // for a person and may be reworded any day; the code
                            // is the part that promised not to change.
                            if (err instanceof ClientFailure && err.code === 'worktree_dirty') {
                              setConfirmRemove(worktree.id)
                              // git's own stderr — it names the actual files —
                              // rides along as `detail`; fall back to the
                              // sentence if a future git version phrases the
                              // refusal differently and `detail` comes back
                              // empty.
                              setDirtyWarning(err.detail || err.message)
                              return
                            }
                            throw err
                          }
                        })
                      }
                    >
                      <Trash2 size={12} />
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
