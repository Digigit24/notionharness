'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createProject } from '@/app/(app)/workspace/[workspaceSlug]/projects/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'
import { unwrap } from '@/lib/failures'

export function AddProjectForm({ workspaceId, workspaceSlug }: { workspaceId: number; workspaceSlug: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('')
  const [isPending, startTransition] = useTransition()
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      const project = unwrap(await createProject({ workspaceId, workspaceSlug, name, icon }))
      toast({ title: `Created project "${project.name}"` })
      setName('')
      setIcon('')
      setOpen(false)
      startTransition(() => {
        router.refresh()
        router.push(`/workspace/${workspaceSlug}/projects/${project.id}`)
      })
    } catch (error) {
      toast({
        title: 'Could not create project',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        New project
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <div className="flex gap-2">
        <Input
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="🚀"
          disabled={saving || isPending}
          className="w-14"
          maxLength={4}
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          disabled={saving || isPending}
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) void submit()
          }}
          autoFocus
        />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={saving || isPending || !name.trim()} onClick={() => void submit()}>
          {saving ? 'Creating…' : 'Create'}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
