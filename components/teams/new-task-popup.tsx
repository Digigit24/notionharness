'use client'

import { useState } from 'react'
import { Bot, ClipboardList, FolderGit2, ListTree } from 'lucide-react'
import type { TeamAgentOption } from './shared'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'

export interface TaskProjectOption {
  id: number
  name: string
}

/**
 * R14-P0.8.1 / R14-P0.8.3 — one popup, two entry points.
 *
 * `mode: 'task'` is the "New task" button beside the composer
 * (`channel-view.tsx`/`thread-pane.tsx`): a project picker, then an agent
 * picker scoped to the workspace once a project is chosen — this codebase
 * has no per-project agent scoping (`collections/Agents.ts` has no `project`
 * field; `components/tasks/task-detail-view.tsx`'s own agent `<select>` is
 * plain workspace-wide too), so "scoped to that project" means what it
 * already means everywhere else in this app: available once a project makes
 * the task real enough to assign.
 *
 * `mode: 'subtask'` is "Create subtask" inside a task-carrying thread: the
 * SAME form, but `lockedProjectName` replaces the picker entirely (the
 * project is the parent's, not a choice) — same popup, per ROADMAP-SERIES.md.
 */
export function NewTaskPopup({
  mode,
  lockedProjectName,
  projects,
  agents,
  disabled,
  onCreate,
}: {
  mode: 'task' | 'subtask'
  /** Set only for `mode: 'subtask'` — the parent task's project name, shown
   * read-only in place of the picker. */
  lockedProjectName?: string | null
  projects: TaskProjectOption[]
  agents: TeamAgentOption[]
  disabled?: boolean
  onCreate: (input: { title: string; projectId: number | null; agentId: number | null }) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState<number | null>(null)
  const [agentId, setAgentId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const isSubtask = mode === 'subtask'
  const canSubmit = title.trim().length > 0 && (isSubtask || projectId != null)

  function reset() {
    setTitle('')
    setProjectId(null)
    setAgentId(null)
  }

  async function submit() {
    if (!canSubmit) return
    setSaving(true)
    try {
      await onCreate({ title: title.trim(), projectId: isSubtask ? null : projectId, agentId })
      setOpen(false)
      reset()
    } catch (error) {
      toast({
        title: isSubtask ? 'Could not create the subtask' : 'Could not create the task',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!saving ? setOpen(next) : undefined)}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={disabled} title={disabled ? 'This thread has no task to attach a subtask to yet' : undefined}>
          {isSubtask ? <ListTree size={13} /> : <ClipboardList size={13} />}
          {isSubtask ? 'Create subtask' : 'New task'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isSubtask ? 'New subtask' : 'New task'}</DialogTitle>
          <DialogDescription>
            {isSubtask
              ? "Opens a real task, linked as this task's child, and replies in this same thread — a task's whole family of subtasks lives in one conversation."
              : 'Opens a real task and a new thread for it in this channel, so you can watch it without leaving.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            rows={3}
            autoFocus
            disabled={saving}
          />

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs text-black/50 dark:text-white/50">
              <FolderGit2 size={12} /> Project
            </label>
            {isSubtask ? (
              <p className="rounded-md border border-black/10 bg-black/[.02] px-2.5 py-1.5 text-sm text-black/70 dark:border-white/10 dark:bg-white/[.03] dark:text-white/70">
                {lockedProjectName ?? 'Same as the parent task'}
              </p>
            ) : (
              <Select
                value={projectId != null ? String(projectId) : undefined}
                onValueChange={(v) => setProjectId(Number(v))}
                disabled={saving || projects.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={projects.length === 0 ? 'This workspace has no projects yet' : 'Choose a project…'} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs text-black/50 dark:text-white/50">
              <Bot size={12} /> Agent (optional)
            </label>
            <Select
              value={agentId != null ? String(agentId) : 'none'}
              onValueChange={(v) => setAgentId(v === 'none' ? null : Number(v))}
              disabled={saving || agents.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="No agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No agent</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agentId != null && (
              <p className="mt-1 text-xs text-black/40 dark:text-white/40">
                Starts a real run against this {isSubtask ? 'subtask' : 'task'} as soon as it&apos;s created.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving || !canSubmit} onClick={() => void submit()}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
