'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Laptop, Plus } from 'lucide-react'
import { addMachine } from '@/app/(app)/workspace/[workspaceSlug]/settings/runtimes/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { toast } from '@/hooks/use-toast'
import { unwrap } from '@/lib/failures'
import { formatRelativeTime } from '@/lib/relative-time'

export interface MachineSummary {
  id: number
  displayName: string
  hostKey: string
  /** Runtime profiles already scoped to this host — computed by the page
   * from the same profile list it renders below, so this costs no extra
   * query. */
  profileCount: number
  /**
   * B9.3 — this machine's dispatcher heartbeat (B9.1), or null when no
   * dispatcher has ever ticked from it. Not the same fact as "has runtime
   * profiles": a machine can be fully configured and simply asleep right
   * now, which `stale: true` says plainly instead of the count alone
   * implying it's ready to run something.
   */
  heartbeat: { lastTickAt: string; stale: boolean } | null
}

/** Green while the dispatcher ticked recently, red once it's gone stale
 * (B9.1's own threshold), grey when nothing has ever ticked from this
 * machine at all — three states, because "never configured" and "was
 * running, now isn't" are different facts a person acts on differently. */
function LiveDot({ heartbeat }: { heartbeat: MachineSummary['heartbeat'] }) {
  const color = !heartbeat
    ? 'bg-black/20 dark:bg-white/20'
    : heartbeat.stale
      ? 'bg-red-500'
      : 'bg-emerald-500'
  const label = !heartbeat
    ? 'No dispatcher has ever ticked from this machine'
    : `${heartbeat.stale ? 'Offline' : 'Online'} — last tick ${formatRelativeTime(heartbeat.lastTickAt)}`
  return <span aria-hidden="true" title={label} className={`size-2 shrink-0 rounded-full ${color}`} />
}

/**
 * "Add a machine" as one visible action, plus the roster of machines this
 * workspace already knows about.
 *
 * Every machine here is one this action was run FROM — there is no way to
 * register a machine you are not currently looking at (see `addMachine`'s
 * own comment for why that is deliberate, not a missing feature). So the
 * form only ever offers "name THIS machine", never a free-text host picker.
 */
export function MachinesSection({
  workspaceId,
  workspaceSlug,
  machines,
  thisHostKey,
}: {
  workspaceId: number
  workspaceSlug: string
  machines: MachineSummary[]
  thisHostKey: string
}) {
  const router = useRouter()
  const thisMachine = machines.find((m) => m.hostKey === thisHostKey) ?? null
  const otherMachines = machines.filter((m) => m.hostKey !== thisHostKey)

  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(thisMachine?.displayName ?? '')
  const [saving, setSaving] = useState(false)
  const [, startTransition] = useTransition()

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast({ title: 'Name is required.', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const result = unwrap(await addMachine({ workspaceId, workspaceSlug, displayName: trimmed }))
      toast({
        title: `${thisMachine ? 'Updated' : 'Added'} machine "${result.host.displayName}"`,
        description:
          result.addedCount === 0
            ? result.skippedCount > 0
              ? 'No new runtimes detected — everything found was already added.'
              : 'No ACP CLIs were detected on this machine.'
            : `Detected and added ${result.addedCount} runtime${result.addedCount === 1 ? '' : 's'}${
                result.skippedCount > 0 ? `, ${result.skippedCount} already added` : ''
              }.`,
      })
      setEditing(false)
      startTransition(() => router.refresh())
    } catch (error) {
      toast({
        title: 'Could not add this machine',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-4">
      <CardContent className="flex flex-col gap-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <Laptop size={14} />
            Machines
          </h2>
          {thisMachine && !editing && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              Detect new runtimes
            </Button>
          )}
        </div>

        {thisMachine && !editing ? (
          <p className="flex items-center gap-1.5 text-xs text-faint">
            <LiveDot heartbeat={thisMachine.heartbeat} />
            This machine is <span className="font-medium text-foreground">{thisMachine.displayName}</span>, with{' '}
            {thisMachine.profileCount} runtime{thisMachine.profileCount === 1 ? '' : 's'} scoped to it.
          </p>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed border-black/15 p-3 dark:border-white/15">
            {!thisMachine && (
              <p className="text-xs text-faint">
                This machine hasn&apos;t been added yet. Name it, and every ACP CLI found on its PATH becomes a
                runtime profile scoped to it in one step.
              </p>
            )}
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Vaibhav's Desktop"
                disabled={saving}
                className="flex-1"
                autoFocus={!thisMachine}
              />
              <Button type="button" size="sm" disabled={saving} onClick={() => void submit()}>
                {saving ? 'Detecting…' : thisMachine ? 'Save & re-detect' : (
                  <>
                    <Plus size={14} />
                    Add this machine
                  </>
                )}
              </Button>
              {thisMachine && (
                <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}

        {otherMachines.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-black/5 pt-2 text-xs text-faint dark:border-white/10">
            {otherMachines.map((machine) => (
              <li key={machine.id} className="flex items-center gap-1.5">
                <LiveDot heartbeat={machine.heartbeat} />
                <Laptop size={11} className="shrink-0" />
                <span className="font-medium text-foreground">{machine.displayName}</span>
                <span>
                  — {machine.profileCount} runtime{machine.profileCount === 1 ? '' : 's'}
                  {machine.heartbeat && !machine.heartbeat.stale ? ' · online' : ''}
                  {machine.heartbeat === null ? ' · never seen' : ''}
                  {machine.heartbeat?.stale ? ` · last seen ${formatRelativeTime(machine.heartbeat.lastTickAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
