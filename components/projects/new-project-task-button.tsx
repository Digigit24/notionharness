'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createTask } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'

// ROADMAP B-1 (project detail header) — the contextual primary action the
// task brief asked for: "New task" for this project, via the existing
// `createTask` server action (extended with an optional `projectId`, see
// its own comment) rather than a new one-off creation path.
export function NewProjectTaskButton({
  workspaceId,
  workspaceSlug,
  projectId,
  defaultStatusId,
  createdById,
}: {
  workspaceId: number
  workspaceSlug: string
  projectId: number
  /** First status by position, in this workspace — mirrors the Tasks
   * board's own "add to a column" default. Null only if the workspace has
   * no statuses configured at all, in which case there's nowhere to put a
   * new task and the button doesn't render. */
  defaultStatusId: number | null
  createdById: number | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, setPending] = useState(false)

  if (defaultStatusId == null || createdById == null) return null

  async function handleClick() {
    setPending(true)
    try {
      await createTask({
        workspaceId,
        workspaceSlug,
        statusId: defaultStatusId!,
        title: 'Untitled',
        createdById: createdById!,
        projectId,
      })
      router.push(`${pathname}?tab=tasks`, { scroll: false })
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <Button size="sm" onClick={() => void handleClick()} disabled={pending}>
      <Plus size={14} /> {pending ? 'Creating…' : 'New task'}
    </Button>
  )
}
