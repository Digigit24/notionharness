'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import type { TeamTask, TeamTaskStatus } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { unwrap } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  BOARD_COLUMNS,
  TASK_STATUS_CLASS,
  TASK_STATUS_LABEL,
  colourOf,
  slotById,
  type TeamSlotView,
} from './shared'
import {
  claimTeamTaskAction,
  createTeamTaskAction,
  reportTeamTaskDoneAction,
  setTeamTaskStatusAction,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'

/** Statuses a human can set by hand. `done` is missing on purpose: finishing a
 * task goes through `reportTeamTaskDone`, which settles it, records what it
 * produced and releases its dependents in one transaction. A plain status
 * flick to `done` would skip the report and the release — exactly the
 * un-acknowledged completion R6.2 says we beat the reference implementation
 * on. */
const MANUAL_STATUSES: TeamTaskStatus[] = ['open', 'claimed', 'in_progress', 'blocked', 'cancelled']

/**
 * Board — the dependency graph, with blocker chips (R6.4).
 *
 * Columns are statuses rather than owners, because the question this view
 * answers is "what is stuck and on what". Ownership is a chip on the card;
 * per-member columns are the Lanes view.
 */
export function BoardView({
  workspaceId,
  teamId,
  slots,
  tasks,
  claimableIds,
  focusTaskId,
  onFocusHandled,
  onTasksChanged,
}: {
  workspaceId: number
  teamId: number
  slots: TeamSlotView[]
  tasks: TeamTask[]
  claimableIds: number[]
  /** A card the channel asked us to show — a task chip in the feed was
   * clicked. Reuses the same jump-and-flash the blocker chips already use, so
   * arriving from a message and arriving from a dependency look identical. */
  focusTaskId: number | null
  /** Cleared once handled, so clicking the same chip twice works. */
  onFocusHandled: () => void
  onTasksChanged: (tasks: TeamTask[]) => void
}) {
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null)
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const [reportingId, setReportingId] = useState<number | null>(null)
  const [summary, setSummary] = useState('')
  const [adding, setAdding] = useState(false)
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [ownerSlotId, setOwnerSlotId] = useState<number | null>(null)
  const [blockedBy, setBlockedBy] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const highlightTimer = useRef<number | null>(null)

  const claimable = useMemo(() => new Set(claimableIds), [claimableIds])
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const columns = useMemo(
    () => BOARD_COLUMNS.map((status) => ({ status, items: tasks.filter((t) => t.status === status) })),
    [tasks],
  )

  /** Jumps to a blocker and marks it for a moment. The graph is only useful if
   * "what is holding this up" is one click, not a scan. */
  const jumpToTask = useCallback((id: number) => {
    const el = document.getElementById(`team-task-${id}`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlightId(id)
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current)
    highlightTimer.current = window.setTimeout(() => setHighlightId(null), 1600)
  }, [])

  // The view has only just switched when this fires, so the card may not be in
  // the DOM yet — hence the effect rather than doing it at the call site in
  // the room. `tasks` participates so a chip for a task that arrives with the
  // next poll still lands.
  useEffect(() => {
    if (focusTaskId == null) return
    if (!tasks.some((t) => t.id === focusTaskId)) return
    jumpToTask(focusTaskId)
    onFocusHandled()
  }, [focusTaskId, tasks, jumpToTask, onFocusHandled])

  function replaceTask(next: TeamTask) {
    onTasksChanged(tasks.map((t) => (t.id === next.id ? next : t)))
  }

  async function withBusy(taskId: number, work: () => Promise<void>) {
    setBusyTaskId(taskId)
    try {
      await work()
    } catch (error) {
      toast({
        title: 'That did not go through',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusyTaskId(null)
    }
  }

  async function createTask() {
    setSaving(true)
    try {
      const task = unwrap(
        await createTeamTaskAction({
          workspaceId,
          teamId,
          subject,
          description,
          ownerSlotId,
          blockedBy,
        }),
      )
      onTasksChanged([...tasks, task])
      setSubject('')
      setDescription('')
      setOwnerSlotId(null)
      setBlockedBy([])
      setAdding(false)
    } catch (error) {
      toast({
        title: 'Could not create the task',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 shrink-0">
        {adding ? (
          <div className="space-y-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What needs doing"
              disabled={saving}
              autoFocus
            />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detail (optional)"
              rows={2}
              disabled={saving}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={ownerSlotId == null ? 'none' : String(ownerSlotId)}
                onValueChange={(v) => setOwnerSlotId(v === 'none' ? null : Number(v))}
                disabled={saving}
              >
                <SelectTrigger className="h-7 w-48 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Unassigned is the default and it is the interesting one:
                      an unowned task with satisfied dependencies is what any
                      idle member can claim. */}
                  <SelectItem value="none">unassigned — anyone can claim</SelectItem>
                  {slots.map((slot) => (
                    <SelectItem key={slot.id} value={String(slot.id)}>
                      {slot.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {tasks.length > 0 && (
                <Select
                  value=""
                  onValueChange={(v) => {
                    const id = Number(v)
                    setBlockedBy((prev) => (prev.includes(id) ? prev : [...prev, id]))
                  }}
                  disabled={saving}
                >
                  <SelectTrigger className="h-7 w-48 text-xs">
                    <SelectValue placeholder="Blocked by…" />
                  </SelectTrigger>
                  <SelectContent>
                    {tasks.map((task) => (
                      <SelectItem key={task.id} value={String(task.id)}>
                        {task.subject}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {blockedBy.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="rounded border border-amber-500/40 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400"
                  onClick={() => setBlockedBy((prev) => prev.filter((b) => b !== id))}
                  title="Remove this dependency"
                >
                  {byId.get(id)?.subject ?? `task ${id}`} ✕
                </button>
              ))}

              <Button
                type="button"
                size="sm"
                className="ml-auto"
                disabled={saving || !subject.trim()}
                onClick={() => void createTask()}
              >
                {saving ? 'Adding…' : 'Add task'}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus size={13} />
            New task
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {columns.map(({ status, items }) => (
          <section key={status} className="flex min-h-0 w-64 shrink-0 flex-col">
            <h2 className={cn('mb-1.5 shrink-0 text-xs font-medium', TASK_STATUS_CLASS[status])}>
              {TASK_STATUS_LABEL[status]} <span className="text-black/30 dark:text-white/30">{items.length}</span>
            </h2>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {items.map((task) => {
                const owner = slotById(slots, task.ownerSlotId)
                const isClaimable = claimable.has(task.id)
                const busy = busyTaskId === task.id
                return (
                  <article
                    key={task.id}
                    id={`team-task-${task.id}`}
                    className={cn(
                      'rounded-lg border p-2.5 text-sm transition-colors',
                      highlightId === task.id
                        ? 'border-amber-500 bg-amber-500/10'
                        : 'border-black/10 dark:border-white/10',
                    )}
                  >
                    <p className="font-medium">{task.subject}</p>
                    {task.description && (
                      <p className="mt-0.5 text-xs whitespace-pre-wrap text-black/55 dark:text-white/55">
                        {task.description}
                      </p>
                    )}

                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                      {owner ? (
                        <span className="inline-flex items-center gap-1 text-black/55 dark:text-white/55">
                          <span
                            aria-hidden
                            className="size-2 rounded-full"
                            style={{ backgroundColor: colourOf(owner) }}
                          />
                          {owner.displayName}
                        </span>
                      ) : (
                        <span className="text-black/40 dark:text-white/40">unassigned</span>
                      )}
                      {/* Claimability is the database's answer, not a guess
                          from status — a blocked task whose blockers all
                          finished is claimable even though its own row still
                          says blocked until someone takes it. */}
                      {isClaimable && (
                        <span className="rounded border border-emerald-500/40 px-1 py-px text-emerald-600 dark:text-emerald-400">
                          claimable
                        </span>
                      )}
                    </div>

                    {task.blockedBy.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {task.blockedBy.map((blockerId) => {
                          const blocker = byId.get(blockerId)
                          const settled = blocker?.status === 'done' || blocker?.status === 'cancelled'
                          return (
                            <button
                              key={blockerId}
                              type="button"
                              onClick={() => jumpToTask(blockerId)}
                              className={cn(
                                'rounded border px-1.5 py-px text-[11px] hover:underline',
                                settled
                                  ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                                  : 'border-amber-500/40 text-amber-600 dark:text-amber-400',
                              )}
                              title={settled ? 'Satisfied — jump to it' : 'Still blocking — jump to it'}
                            >
                              {blocker?.subject ?? `task ${blockerId}`}
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {task.result && (
                      <p className="mt-1.5 rounded bg-black/[.04] p-1.5 text-xs whitespace-pre-wrap dark:bg-white/[.06]">
                        {task.result}
                      </p>
                    )}

                    {task.status !== 'done' && task.status !== 'cancelled' && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {task.ownerSlotId == null && slots.length > 0 && (
                          <Select
                            value=""
                            disabled={busy}
                            onValueChange={(v) =>
                              void withBusy(task.id, async () => {
                                const next = unwrap(
                                  await claimTeamTaskAction({
                                    workspaceId,
                                    teamId,
                                    taskId: task.id,
                                    slotId: Number(v),
                                  }),
                                )
                                replaceTask(next)
                              })
                            }
                          >
                            <SelectTrigger className="h-6 w-32 text-[11px]">
                              <SelectValue placeholder="Claim for…" />
                            </SelectTrigger>
                            <SelectContent>
                              {slots.map((slot) => (
                                <SelectItem key={slot.id} value={String(slot.id)}>
                                  {slot.displayName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}

                        <Select
                          value={task.status}
                          disabled={busy}
                          onValueChange={(v) =>
                            void withBusy(task.id, async () => {
                              const next = unwrap(
                                await setTeamTaskStatusAction({
                                  workspaceId,
                                  teamId,
                                  taskId: task.id,
                                  status: v as TeamTaskStatus,
                                }),
                              )
                              replaceTask(next)
                            })
                          }
                        >
                          <SelectTrigger className="h-6 w-28 text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MANUAL_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {TASK_STATUS_LABEL[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setReportingId(reportingId === task.id ? null : task.id)
                            setSummary('')
                          }}
                        >
                          <Check size={12} />
                          Report done
                        </Button>
                      </div>
                    )}

                    {reportingId === task.id && (
                      <div className="mt-2 space-y-1.5">
                        <Textarea
                          value={summary}
                          onChange={(e) => setSummary(e.target.value)}
                          placeholder="What did it produce?"
                          rows={2}
                          disabled={busy}
                        />
                        <Button
                          type="button"
                          size="xs"
                          disabled={busy || !summary.trim()}
                          onClick={() =>
                            void withBusy(task.id, async () => {
                              const result = unwrap(
                                await reportTeamTaskDoneAction({
                                  workspaceId,
                                  teamId,
                                  taskId: task.id,
                                  slotId: task.ownerSlotId,
                                  summary,
                                }),
                              )
                              // The whole board, not one row: settling a task
                              // flips every dependent it unblocked in the same
                              // transaction.
                              onTasksChanged(result.tasks)
                              setReportingId(null)
                              setSummary('')
                              toast({
                                title: 'Task settled',
                                description:
                                  result.releasedIds.length > 0
                                    ? `${result.releasedIds.length} ${
                                        result.releasedIds.length === 1 ? 'task is' : 'tasks are'
                                      } now claimable.`
                                    : 'The report is in the channel.',
                              })
                            })
                          }
                        >
                          Settle and report
                        </Button>
                      </div>
                    )}
                  </article>
                )
              })}
              {items.length === 0 && (
                <p className="rounded-lg border border-dashed border-black/10 px-2 py-4 text-center text-[11px] text-black/30 dark:border-white/10 dark:text-white/30">
                  empty
                </p>
              )}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-2 shrink-0 text-[11px] text-black/35 dark:text-white/35">
        Reporting a task done writes its report into the channel and releases whatever it was blocking, in one
        transaction. The per-member merge action R6.4 asks for is not here: no slot is bound to a worktree yet.
      </p>
    </div>
  )
}
