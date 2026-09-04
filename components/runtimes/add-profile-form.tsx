'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createRuntimeProfile } from '@/app/(app)/workspace/[workspaceSlug]/settings/runtimes/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'
import type { RuntimeProfile } from '@/payload-types'

export function AddRuntimeProfileForm({ workspaceId, workspaceSlug }: { workspaceId: number; workspaceSlug: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [protocolFamily, setProtocolFamily] = useState<RuntimeProfile['protocolFamily']>('acp')
  const [commandName, setCommandName] = useState('')
  const [isPending, startTransition] = useTransition()
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      await createRuntimeProfile({ workspaceId, workspaceSlug, name, protocolFamily, commandName })
      toast({ title: `Added runtime profile "${name.trim()}"` })
      setName('')
      setCommandName('')
      setOpen(false)
      startTransition(() => router.refresh())
    } catch (error) {
      toast({
        title: 'Could not add runtime profile',
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
        Add runtime profile
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. Claude Code)"
          disabled={saving || isPending}
          className="flex-1"
        />
        <select
          value={protocolFamily}
          onChange={(e) => setProtocolFamily(e.target.value as RuntimeProfile['protocolFamily'])}
          disabled={saving || isPending}
          className="rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/10"
        >
          <option value="acp">ACP</option>
          <option value="mcp">MCP</option>
        </select>
      </div>
      <Input
        value={commandName}
        onChange={(e) => setCommandName(e.target.value)}
        placeholder="Command (e.g. hermes-acp)"
        disabled={saving || isPending}
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={saving || isPending} onClick={() => void submit()}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
