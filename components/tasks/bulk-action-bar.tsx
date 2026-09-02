'use client'

import { useState } from 'react'
import { Archive, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Agent, Project, TaskStatus } from '@/payload-types'

// ROADMAP B-4 "Work" — "Select many, then: change status, assign to an
// agent, add to a project, archive." Renders only while >=1 card is
// selected (task-board.tsx owns the selection Set and only mounts this when
// it's non-empty).
//
// UX choice for entering multi-select, documented here since the plan
// explicitly asked for a decision + rationale: a dedicated "Select" mode
// toggle in the board header, not a per-card hover checkbox. A kanban board
// already spends its entire card surface on drag-and-drop (`useDraggable`'s
// listeners are bound to the whole card in task-board.tsx's `TaskCard`) —
// overlaying a hover checkbox in the same hit-target would mean every click
// has to disambiguate "start a drag" vs. "toggle a checkbox," and a
// mis-click either drags a card into the wrong column or fails to select it.
// A single mode toggle sidesteps the conflict entirely: outside select mode,
// cards drag exactly as before; inside it, dragging is disabled
// (`useDraggable({ disabled: selectMode })`) and every card tap toggles
// selection instead of opening the drawer. Cheap to leave and cheap to
// re-enter, so it doesn't cost much over a hover checkbox for the common
// case of selecting a handful of cards to bulk-act on.
export function BulkActionBar({
  selectedCount,
  statuses,
  agents,
  projects,
  archiveStatus,
  busy,
  onChangeStatus,
  onAssignAgent,
  onAddToProject,
  onArchive,
  onClear,
}: {
  selectedCount: number
  statuses: TaskStatus[]
  agents: Agent[]
  projects: Project[]
  /** The workspace's status whose `category` is `'cancelled'` (if one is configured) — see this component's own Archive-button comment. */
  archiveStatus: TaskStatus | null
  busy: boolean
  onChangeStatus: (statusId: number) => void
  onAssignAgent: (agentId: number | null) => void
  onAddToProject: (projectId: number | null) => void
  onArchive: () => void
  onClear: () => void
}) {
  const [statusValue, setStatusValue] = useState<string>('')
  const [agentValue, setAgentValue] = useState<string>('')
  const [projectValue, setProjectValue] = useState<string>('')

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-black/10 bg-white px-4 py-2 dark:border-white/10 dark:bg-[#1f1f1f]">
      <span className="text-xs font-medium text-black/60 dark:text-white/60">
        {selectedCount} selected
      </span>

      <Select
        value={statusValue}
        onValueChange={(value) => {
          setStatusValue(value)
          onChangeStatus(Number(value))
        }}
        disabled={busy}
      >
        <SelectTrigger size="sm" className="h-7">
          <SelectValue placeholder="Change status…" />
        </SelectTrigger>
        <SelectContent>
          {statuses.map((status) => (
            <SelectItem key={status.id} value={String(status.id)}>
              {status.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={agentValue}
        onValueChange={(value) => {
          setAgentValue(value)
          onAssignAgent(value === 'none' ? null : Number(value))
        }}
        disabled={busy}
      >
        <SelectTrigger size="sm" className="h-7">
          <SelectValue placeholder="Assign agent…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No agent</SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={String(agent.id)}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={projectValue}
        onValueChange={(value) => {
          setProjectValue(value)
          onAddToProject(value === 'none' ? null : Number(value))
        }}
        disabled={busy}
      >
        <SelectTrigger size="sm" className="h-7">
          <SelectValue placeholder="Add to project…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No project</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={String(project.id)}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7"
        disabled={busy || !archiveStatus}
        onClick={onArchive}
        title={
          archiveStatus
            ? `Moves selected tasks to "${archiveStatus.name}" (this workspace's 'cancelled'-category status). A dedicated archived flag is written but not yet migrated — see collections/Tasks.ts.`
            : "This workspace has no 'cancelled'-category status configured, so there's nowhere real to archive to yet — add one, or apply migrations/20260902_130000_tasks_archived.ts for a dedicated archived flag."
        }
      >
        <Archive size={12} /> Archive
      </Button>

      {busy && <Loader2 size={14} className="animate-spin text-black/40 dark:text-white/40" />}

      <button
        type="button"
        onClick={onClear}
        className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-black/40 hover:bg-black/[.06] dark:text-white/40 dark:hover:bg-white/[.08]"
      >
        <X size={12} /> Clear
      </button>
    </div>
  )
}
