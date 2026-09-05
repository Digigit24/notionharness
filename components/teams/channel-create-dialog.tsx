'use client'

import { useMemo, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, Crown, Hash, Lock, User, X } from 'lucide-react'
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
import { unwrap } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { createChannelAction, type ChannelMemberDraft } from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import { initialsOf, slotColourFor, type TeamAgentOption, type TeamUserOption } from './shared'

interface DraftSlot {
  /** Local only — a key for React and for the leader choice. Slots have no
   * server id until the channel is created, and two slots may name the same
   * agent, so the agent id cannot be the key. */
  key: number
  kind: 'agent' | 'user'
  refId: number
  displayName: string
}

/**
 * Create a channel: name it, say what it is for, decide who is in it.
 *
 * Two rules this form exists to honour.
 *
 * **A slot is not an agent.** Adding the same agent twice produces two slots
 * with two jobs, two threads and two colours, so the picker deliberately does
 * not disable an agent already in the roster and nothing here deduplicates by
 * agent id. That is R6.1's model and it is the thing a naive implementation
 * gets wrong.
 *
 * **A member can be a person.** Migration 0013 made `team_members.agent_id`
 * nullable and added `user_id`, with a CHECK that exactly one is set — so the
 * picker offers both lists, and a channel of people with no agents at all is a
 * perfectly ordinary thing to make.
 *
 * People are NOT deduplicated in the picker either, but adding the same person
 * twice is refused on submit rather than silently allowed: two agent slots have
 * two conversations and two jobs, whereas two slots for one person would give
 * that person two read cursors and two "you reacted" states in one room, which
 * is a bug wearing a feature's clothes.
 */
export function ChannelCreateDialog({
  workspaceId,
  workspaceSlug,
  agents,
  users,
  trigger,
}: {
  workspaceId: number
  workspaceSlug: string
  agents: TeamAgentOption[]
  users: TeamUserOption[]
  /** Defaults to the "New channel" button the Teams page uses. The sidebar's
   * "+" icon passes its own compact trigger instead — same dialog, same
   * submit, just a different way in. */
  trigger?: ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [mode, setMode] = useState<TeamWorkspaceMode>('per_member')
  const [slots, setSlots] = useState<DraftSlot[]>([])
  const [leaderKey, setLeaderKey] = useState<number | null>(null)
  const [nextKey, setNextKey] = useState(1)
  const [saving, setSaving] = useState(false)
  const [, startTransition] = useTransition()

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])

  function addSlot(kind: 'agent' | 'user', refId: number) {
    const label = kind === 'agent' ? agentById.get(refId)?.name : userById.get(refId)?.name
    if (!label) return
    if (kind === 'user' && slots.some((s) => s.kind === 'user' && s.refId === refId)) {
      toast({ title: `${label} is already in this channel` })
      return
    }
    const key = nextKey
    setNextKey(key + 1)
    setSlots((prev) => {
      // The default name disambiguates a repeated agent immediately — "Coder"
      // and "Coder 2" — because two rows reading "Coder" is precisely the
      // confusion slots are supposed to resolve.
      const same = prev.filter((s) => s.kind === kind && s.refId === refId).length
      return [...prev, { key, kind, refId, displayName: same === 0 ? label : `${label} ${same + 1}` }]
    })
    // First AGENT added leads by default. A channel with no leader is legal and
    // works (the board is authoritative), and a human leader is legal too — but
    // a human leader has no run, so nothing auto-delegates, and defaulting to
    // that would look broken rather than deliberate. See migration 0013's note.
    if (kind === 'agent') setLeaderKey((current) => current ?? key)
  }

  function reset() {
    setName('')
    setTopic('')
    setIsPrivate(false)
    setMode('per_member')
    setSlots([])
    setLeaderKey(null)
  }

  async function submit() {
    setSaving(true)
    try {
      const leaderIndex = leaderKey == null ? null : slots.findIndex((s) => s.key === leaderKey)
      const members: ChannelMemberDraft[] = slots.map((s) =>
        s.kind === 'agent'
          ? { kind: 'agent', agentId: s.refId, displayName: s.displayName }
          : { kind: 'user', userId: s.refId, displayName: s.displayName },
      )
      const { teamId } = unwrap(
        await createChannelAction({
          workspaceId,
          workspaceSlug,
          name,
          topic,
          isPrivate,
          workspaceMode: mode,
          members,
          leaderIndex: leaderIndex != null && leaderIndex >= 0 ? leaderIndex : null,
        }),
      )
      toast({ title: `Created #${name.trim().replace(/^#+/, '')}` })
      setOpen(false)
      reset()
      startTransition(() => {
        router.refresh()
        router.push(`/workspace/${workspaceSlug}/teams/${teamId}`)
      })
    } catch (error) {
      // The unique index on (workspace_id, lower(name)) is surfaced as a
      // sentence by the action, not as a constraint name — see
      // `isDuplicateChannelName` there.
      toast({
        title: 'Could not create the channel',
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
        {trigger ?? (
          <Button type="button" size="sm">
            <Hash size={14} />
            New channel
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New channel</DialogTitle>
          <DialogDescription>
            A channel is a room with a feed, threads and a canvas. Members can be agents or people — and the same
            agent can be added twice, as two slots with two jobs.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-1.5 rounded-md border border-black/10 pl-2.5 focus-within:border-black/25 dark:border-white/15 dark:focus-within:border-white/30">
            <Hash size={14} className="shrink-0 text-black/35 dark:text-white/35" aria-hidden />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="design-review"
              disabled={saving}
              autoFocus
              className="border-0 px-0 focus-visible:ring-0"
            />
          </div>
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic (optional) — what this channel is for"
            disabled={saving}
          />

          <button
            type="button"
            disabled={saving}
            onClick={() => setIsPrivate((v) => !v)}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left',
              isPrivate
                ? 'border-amber-500/40 bg-amber-500/[.05]'
                : 'border-black/10 hover:bg-black/[.03] dark:border-white/10 dark:hover:bg-white/[.05]',
            )}
          >
            <Lock
              size={14}
              className={cn('mt-0.5 shrink-0', isPrivate ? 'text-amber-600 dark:text-amber-400' : 'text-black/35 dark:text-white/35')}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{isPrivate ? 'Private channel' : 'Public channel'}</span>
              <span className="block text-xs text-black/45 dark:text-white/45">
                {isPrivate
                  ? 'Only its members can find it or open it. You are added automatically.'
                  : 'Anyone in the workspace can find it and join.'}
              </span>
            </span>
            <span
              aria-hidden
              className={cn(
                'mt-0.5 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors',
                isPrivate ? 'bg-amber-500' : 'bg-black/15 dark:bg-white/20',
              )}
            >
              <span
                className={cn(
                  'block size-3 rounded-full bg-white transition-transform',
                  isPrivate && 'translate-x-3',
                )}
              />
            </span>
          </button>

          <div>
            <label className="mb-1 block text-xs text-black/50 dark:text-white/50">Members</label>
            {slots.length === 0 && (
              <p className="mb-2 text-xs text-black/40 dark:text-white/40">
                Nobody yet. You are always added to a channel you create; everyone else is optional.
              </p>
            )}
            <ul className="space-y-1.5">
              {slots.map((slot, index) => (
                <li key={slot.key} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white"
                    style={{ backgroundColor: slotColourFor(index) }}
                  >
                    {initialsOf(slot.displayName)}
                  </span>
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
                  <span className="flex w-24 shrink-0 items-center gap-1 truncate text-xs text-black/40 dark:text-white/40">
                    {slot.kind === 'agent' ? <Bot size={11} /> : <User size={11} />}
                    <span className="truncate">
                      {slot.kind === 'agent'
                        ? (agentById.get(slot.refId)?.name ?? 'unknown agent')
                        : (userById.get(slot.refId)?.name ?? 'unknown person')}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant={leaderKey === slot.key ? 'default' : 'ghost'}
                    className="h-8 px-2"
                    title={
                      leaderKey === slot.key
                        ? 'Leads this channel'
                        : slot.kind === 'user'
                          ? 'Make leader — note that a human leader delegates by hand; nothing dispatches on its own'
                          : 'Make leader'
                    }
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
                    title="Remove"
                    disabled={saving}
                    onClick={() => {
                      setSlots((prev) => prev.filter((s) => s.key !== slot.key))
                      setLeaderKey((current) => (current === slot.key ? null : current))
                    }}
                  >
                    <X size={13} />
                  </Button>
                </li>
              ))}
            </ul>

            <div className="mt-2">
              <Select
                // Reset to no value after each pick so the SAME agent can be
                // chosen again immediately. A controlled Select that keeps the
                // last value would swallow the second click on that agent,
                // which is the one interaction slots exist for.
                value=""
                onValueChange={(v) => {
                  const [kind, raw] = v.split(':')
                  addSlot(kind === 'user' ? 'user' : 'agent', Number(raw))
                }}
                disabled={saving || (agents.length === 0 && users.length === 0)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Add an agent or a person…" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={`agent-${agent.id}`} value={`agent:${agent.id}`}>
                      {agent.name}
                    </SelectItem>
                  ))}
                  {users.map((user) => (
                    <SelectItem key={`user-${user.id}`} value={`user:${user.id}`}>
                      {user.name} · person
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

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
              Recorded on the channel now; binding the actual worktrees is not wired up yet.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving || !name.trim()} onClick={() => void submit()}>
            {saving ? 'Creating…' : 'Create channel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
