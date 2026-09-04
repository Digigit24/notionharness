'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FolderGit2, GitBranch, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState } from '@/components/ui/empty-state'
import { toast } from '@/hooks/use-toast'
import { unwrap } from '@/lib/failures'
import {
  createProjectResource,
  deleteProjectResource,
} from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/actions'
import type { ProjectResource } from '@/payload-types'

type Kind = ProjectResource['kind']
type Role = ProjectResource['role']

export function ProjectResourcesTab({
  projectId,
  workspaceSlug,
  initialResources,
  compact = false,
}: {
  projectId: number
  workspaceSlug: string
  initialResources: ProjectResource[]
  /** Rendered in the detail page's right rail rather than as a full tab:
   * drops the page padding and the max-width, which exist for a tab body and
   * would waste most of a 320px column. */
  compact?: boolean
}) {
  const router = useRouter()
  const [resources, setResources] = useState(initialResources)
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<Kind>('git_repo')
  const [role, setRole] = useState<Role>('primary')
  const [path, setPath] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [saving, setSaving] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)

  async function handleCreate() {
    setSaving(true)
    try {
      const resource = unwrap(
        await createProjectResource({
          projectId,
          workspaceSlug,
          data: {
            kind,
            role,
            path: path.trim() || null,
            repoUrl: kind === 'git_repo' ? repoUrl.trim() || null : null,
            defaultBranch: kind === 'git_repo' ? defaultBranch.trim() || null : null,
            writable: true,
          },
        }),
      )
      setResources((current) => [...current, resource])
      setAdding(false)
      setPath('')
      setRepoUrl('')
      router.refresh()
    } catch (err) {
      toast({
        title: 'Could not add resource',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(resourceId: number) {
    try {
      unwrap(await deleteProjectResource({ resourceId, projectId, workspaceSlug }))
    } catch (err) {
      // A failed delete used to remove the row from the list anyway, so the
      // resource reappeared on the next refresh with nothing said. Keep it,
      // and say why.
      toast({
        title: 'Could not delete resource',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
      return
    }
    setResources((current) => current.filter((r) => r.id !== resourceId))
    setPendingDeleteId(null)
    router.refresh()
  }

  return (
    <div className={compact ? 'flex flex-col gap-3' : 'max-w-2xl p-6'}>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-black/50 dark:text-white/50">
          Which git repos or local directories this project&apos;s runs work against — the runtime&apos;s own
          filesystem, not this browser&apos;s.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add resource'}
        </Button>
      </div>

      {adding && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/10">
          <div className="grid grid-cols-2 gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger size="sm" className="text-sm">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="git_repo">Git repo</SelectItem>
                <SelectItem value="local_dir">Local directory</SelectItem>
              </SelectContent>
            </Select>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger size="sm" className="text-sm">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="primary">Primary</SelectItem>
                <SelectItem value="reference">Reference</SelectItem>
                <SelectItem value="output">Output</SelectItem>
                <SelectItem value="scratch">Scratch</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Absolute path on the runtime (optional for a not-yet-cloned repo)"
          />
          {kind === 'git_repo' && (
            <div className="grid grid-cols-2 gap-2">
              <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="Repo URL" />
              <Input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="Default branch" />
            </div>
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={saving} onClick={() => void handleCreate()}>
              {saving ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      )}

      {resources.length === 0 ? (
        <EmptyState
          icon={<FolderGit2 />}
          title="No resources yet"
          description="Add the git repo or directory this project's agent runs should work against."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
          {resources.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3">
              {r.kind === 'git_repo' ? (
                <GitBranch size={16} className="shrink-0 text-black/40 dark:text-white/40" />
              ) : (
                <FolderGit2 size={16} className="shrink-0 text-black/40 dark:text-white/40" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.repoUrl || r.path || 'Untitled resource'}</span>
                <span className="block truncate text-xs text-black/40 dark:text-white/40">
                  {r.role} · {r.kind === 'git_repo' ? 'git repo' : 'local dir'}
                  {r.defaultBranch ? ` · ${r.defaultBranch}` : ''}
                </span>
              </span>
              {pendingDeleteId === r.id ? (
                <div className="flex shrink-0 gap-1">
                  <Button type="button" size="sm" variant="destructive" onClick={() => void handleDelete(r.id)}>
                    Confirm
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setPendingDeleteId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  title="Delete resource"
                  onClick={() => setPendingDeleteId(r.id)}
                  className="shrink-0 rounded p-1 text-black/40 hover:bg-black/[.06] hover:text-red-500 dark:text-white/40 dark:hover:bg-white/[.08]"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
