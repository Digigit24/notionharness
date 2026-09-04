'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Crown, Plus, X } from 'lucide-react'
import type { TeamWorkspaceMode } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { createTeamAction } from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import { slotColourFor } from './shared'

export interface TeamAgentOption {
  id: number
  name: string
}

interface DraftSlot {
  /** Local only — a key for React and for the leader radio. Slots have no
   * server id until the team is created, and two slots may name the same
   * agent, so the agent id cannot be the key. */
  key: number
  agentId: number
  displayName: string
}

/**
 * Create a team: name it, add agents as slots, pick a leader.
 *
 * The one rule this form exists to honour: **a slot is not an agent**. Adding
 * the same agent twice produces two slots with two jobs, two threads and two
 * colours, so the agent picker deliberately does not disable an agent that is
 * already in the roster and nothing here deduplicates by agent id. That is
 * R6.1's model, and it is also the thing a naive implementation gets wrong.
 */
export function CreateTeamForm({
  workspaceId,
  workspaceSlug,
  agents,
}: {
  workspaceId: number
  workspaceSlug: string
  agents: TeamAgentOption[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<TeamWorkspaceMode>('per_member')
  const [slots, setSlots] = useState<DraftSlot[]>([])
  const [leaderKey, setLeaderKey] = useState<number | null>(null)
  const [nextKey, setNextKey] = useState(1)
  const [saving, setSaving] = useState(false)
  const [, startTransition] = useTransition()

  function addSlot(agentId: number) {
    const agent = agents.find((a) => a.id === agentId)
    if (!agent) return
    const key = nextKey
    setNextKey(key + 1)
    setSlots((prev) => {
      // The default name disambiguates a repeated agent immediately — "Coder"
      // and "Coder 2" — because two rows reading "Coder" is precisely the
      // confusion slots are supposed to resolve.
      const sameAgent = prev.filter((s) => s.agentId === agentId).length
      const displayName = sameAgent === 0 ? agent.name : `${agent.name} ${sameAgent + 1}`
      return [...prev, { key, agentId, displayName }]
    })
    // First slot added leads by default: a team with no leader is legal and
    // works (the board is authoritative), but it is not what someone building
    // their first room expects.
    setLeaderKey((current) => current ?? key)
  }

  function removeSlot(key: number) {
    setSlots((prev) => prev.filter((s) => s.key !== key))
    setLeaderKey((current) => (current === key ? null : current))
  }

  function reset() {
    setName('')
    setDescription('')
    setMode('per_member')
    setSlots([])
    setLeaderKey(null)
  }

  async function submit() {
    setSaving(true)
    try {
      const leaderIndex = leaderKey == null ? null : slots.findIndex((s) => s.key === leaderKey)
      const { teamId } = await createTeamAction({
        workspaceId,
        workspaceSlug,
        name,
        description,
        workspaceMode: mode,
        slots: slots.map((s) => ({ agentId: s.agentId, displayName: s.displayName })),
        leaderIndex: leaderIndex != null && leaderIndex >= 0 ? leaderIndex : null,
      })
      toast({ title: `Created team "${name.trim()}"` })
      setOpen(false)
      reset()
      startTransition(() => {
        router.refresh()
        router.push(`/workspace/${workspaceSlug}/teams/${teamId}`)
      })
    } catch (error) {
      toast({
        title: 'Could not create the team',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={agents.length === 0}>
          New team
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New team</DialogTitle>
          <DialogDescription>
            Add agents as slots. The same agent can be added twice — each slot gets its own job, thread and colour.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Team name"
            disabled={saving}
            autoFocus
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this room is for (optional)"
            disabled={saving}
          />

          <div>
            <label className="mb-1 block text-xs text-black/50 dark:text-white/50">Working copy</label>
            <Select value={mode} onValueChange={(v) => setMode(v as TeamWorkspaceMode)} disabled={saving}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per_member">One worktree per member</SelectItem>
                <SelectItem value="shared">One shared worktree</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-black/40 dark:text-white/40">
              Recorded on the team now; binding the actual worktrees is not wired up yet.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs text-black/50 dark:text-white/50">Roster</label>
            {slots.length === 0 && (
              <p className="mb-2 text-xs text-black/40 dark:text-white/40">
                No slots yet. A team with no members is allowed, but nothing can be assigned.
              </p>
            )}
            <ul className="space-y-1.5">
              {slots.map((slot, index) => {
                const agent = agents.find((a) => a.id === slot.agentId)
                return (
                  <li key={slot.key} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: slotColourFor(index) }}
                    />
                    <Input
                      value={slot.displayName}
                      onChange={(e) =>
                        setSlots((prev) =>
                          prev.map((s) => (s.key === slot.key ? { ...s, displayName: e.target.value } : s)),
                        )
                      }
                      disabled={saving}
                      className="h-8 flex-1"
                    />
                    <span className="w-24 shrink-0 truncate text-xs text-black/40 dark:text-white/40">
                      {agent?.name ?? 'unknown agent'}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant={leaderKey === slot.key ? 'default' : 'ghost'}
                      className="h-8 px-2"
                      title={leaderKey === slot.key ? 'Leads this team' : 'Make leader'}
                      disabled={saving}
                      onClick={() => setLeaderKey(leaderKey === slot.key ? null : slot.key)}
                    >
                      <Crown size={13} />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2"
                      title="Remove slot"
                      disabled={saving}
                      onClick={() => removeSlot(slot.key)}
                    >
                      <X size={13} />
                    </Button>
                  </li>
                )
              })}
            </ul>

            <div className="mt-2 flex items-center gap-2">
              <Select
                // Reset to no value after each pick so the SAME agent can be
                // chosen again immediately. A controlled Select that keeps the
                // last value would swallow the second click on that agent,
                // which is the one interaction slots exist for.
                value=""
                onValueChange={(v) => addSlot(Number(v))}
                disabled={saving}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Add an agent as a slot…" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={String(agent.id)}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Plus size={14} className="shrink-0 text-black/30 dark:text-white/30" aria-hidden />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving || !name.trim()} onClick={() => void submit()}>
            {saving ? 'Creating…' : 'Create team'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
