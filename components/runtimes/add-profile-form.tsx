'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { createRuntimeProfile } from '@/app/(app)/workspace/[workspaceSlug]/settings/runtimes/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'
import { useOptimisticAction } from '@/lib/optimistic'
import { catalogEntryForCommand } from '@/lib/runtimes/catalog'
import { RuntimeCatalogPicker } from '@/components/runtimes/runtime-catalog-picker'
import type { RuntimeProfile } from '@/payload-types'

/** One row this form has told the list about optimistically, before the
 * server's real id comes back. Deliberately NOT the same shape as a real
 * `RuntimeProfile` — a stub must never be mistaken for one by a probe button
 * or a toggle that expects a real database id. */
interface PendingProfile {
  tempId: string
  name: string
  protocolFamily: RuntimeProfile['protocolFamily']
  commandLine: string
}

export function AddRuntimeProfileForm({
  workspaceId,
  workspaceSlug,
  existingProfiles = [],
}: {
  workspaceId: number
  workspaceSlug: string
  /** Read-only — used only to compute the catalog picker's honest "Ready"
   * badge (see `lib/runtimes/catalog.ts`'s header comment for why that badge
   * is cross-referenced against already-probed profiles rather than spawning
   * a presence check per catalog entry). This form never mutates it. */
  existingProfiles?: Pick<RuntimeProfile, 'commandName' | 'lastProbeCode'>[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [name, setName] = useState('')
  const [protocolFamily, setProtocolFamily] = useState<RuntimeProfile['protocolFamily']>('acp')
  const [commandName, setCommandName] = useState('')
  const [commandArgs, setCommandArgs] = useState('')
  // Set when the editor was opened from the catalog; a manually typed
  // command infers its strategy from the command itself at submit time.
  const [pickedHomeStrategy, setPickedHomeStrategy] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [pendingProfiles, setPendingProfiles] = useState<PendingProfile[]>([])
  const optimistic = useOptimisticAction<RuntimeProfile>()

  const probedCommandLines = useMemo(
    () =>
      new Set(
        existingProfiles
          .filter((p) => p.lastProbeCode === 'ok')
          .map((p) => p.commandName.trim())
          .filter(Boolean),
      ),
    [existingProfiles],
  )

  function openManual(prefill?: {
    name: string
    protocolFamily: RuntimeProfile['protocolFamily']
    commandLine: string
    homeStrategy?: string
  }) {
    setPickedHomeStrategy(prefill?.homeStrategy ?? null)
    if (prefill) {
      setName(prefill.name)
      setProtocolFamily(prefill.protocolFamily)
      // A catalog entry's args are already folded into one string here
      // (`catalogEntryCommandLine`) — split them back into the two visible
      // fields only for editing convenience; the two are rejoined the same
      // way on submit.
      const [command, ...rest] = prefill.commandLine.split(' ')
      setCommandName(command ?? '')
      setCommandArgs(rest.join(' '))
    }
    setOpen(true)
  }

  async function submit() {
    const trimmedName = name.trim()
    const trimmedCommand = commandName.trim()
    const trimmedArgs = commandArgs.trim()
    if (!trimmedName || !trimmedCommand) {
      toast({ title: 'Name and command are both required.', variant: 'destructive' })
      return
    }
    const commandLine = trimmedArgs ? `${trimmedCommand} ${trimmedArgs}` : trimmedCommand
    // The identity strategy the run path will use. From the catalog when the
    // editor was opened from it; otherwise inferred from the command, so a
    // hand-typed `hermes-acp` still gets the Hermes home and a hand-typed
    // `opencode acp` gets its linked home. A command the catalog does not
    // recognise gets 'none' — the honest default for a CLI we know nothing
    // about, rather than the collection's Hermes default sending it a
    // HERMES_HOME it cannot use.
    const homeStrategy = pickedHomeStrategy ?? catalogEntryForCommand(commandLine)?.homeStrategy ?? 'none'

    // Paint the row immediately, THEN close and clear the editor — a person
    // who just typed a command should see it land before the inputs blank
    // out from under them.
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const stub: PendingProfile = { tempId, name: trimmedName, protocolFamily, commandLine }

    await optimistic.run({
      apply: () => {
        setPendingProfiles((current) => [...current, stub])
        setName('')
        setCommandName('')
        setCommandArgs('')
        setOpen(false)
      },
      rollback: () => setPendingProfiles((current) => current.filter((p) => p.tempId !== tempId)),
      work: () =>
        createRuntimeProfile({
          workspaceId,
          workspaceSlug,
          name: trimmedName,
          protocolFamily,
          commandName: commandLine,
          homeStrategy,
        }),
      failureTitle: 'Could not add runtime profile',
      onSettled: (created) => {
        toast({ title: `Added runtime profile "${created.name}"` })
        // The real row now exists in the server-rendered list below this
        // form; drop the stub and refresh so that list picks it up. Refresh
        // runs in a transition so it never blocks the stub-removal paint.
        setPendingProfiles((current) => current.filter((p) => p.tempId !== tempId))
        startTransition(() => router.refresh())
      },
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => setCatalogOpen(true)}>
          + Add runtimes
        </Button>
        {!open && (
          <Button type="button" size="sm" variant="outline" onClick={() => openManual()}>
            Enter a command manually
          </Button>
        )}
      </div>

      {pendingProfiles.length > 0 && (
        <ul className="flex flex-col gap-2">
          {pendingProfiles.map((stub) => (
            <li
              key={stub.tempId}
              className="flex items-center gap-2 rounded-lg border border-dashed border-black/15 px-3 py-2 text-sm dark:border-white/15"
            >
              <Loader2 size={14} className="shrink-0 animate-spin text-faint" />
              <span className="font-medium">{stub.name}</span>
              <span className="text-xs text-faint">
                {stub.protocolFamily.toUpperCase()} · <code>{stub.commandLine}</code>
              </span>
              <span className="ml-auto text-xs text-faint">Adding…</span>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/10">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (e.g. Claude Code)"
              disabled={optimistic.pending || isPending}
              className="flex-1"
            />
            <select
              value={protocolFamily}
              onChange={(e) => setProtocolFamily(e.target.value as RuntimeProfile['protocolFamily'])}
              disabled={optimistic.pending || isPending}
              className="rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/10"
            >
              <option value="acp">ACP</option>
              <option value="mcp">MCP</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Input
              value={commandName}
              onChange={(e) => setCommandName(e.target.value)}
              placeholder="Command (e.g. hermes-acp, codex-acp, opencode)"
              disabled={optimistic.pending || isPending}
              className="flex-1"
            />
            <Input
              value={commandArgs}
              onChange={(e) => setCommandArgs(e.target.value)}
              placeholder="Args (optional)"
              disabled={optimistic.pending || isPending}
              className="flex-1"
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={optimistic.pending || isPending} onClick={() => void submit()}>
              {optimistic.pending ? 'Adding…' : 'Add'}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={optimistic.pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <RuntimeCatalogPicker
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        probedCommandLines={probedCommandLines}
        onPick={(selection) => openManual(selection)}
        onManual={() => openManual()}
      />
    </div>
  )
}
