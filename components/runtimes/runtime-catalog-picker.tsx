'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  RUNTIME_CATALOG,
  catalogEntryCommandLine,
  isCatalogEntryReady,
  type RuntimeCatalogEntry,
} from '@/lib/runtimes/catalog'
import type { RuntimeProfile } from '@/payload-types'

/**
 * R14-P0.6 — the runtime catalog picker.
 *
 * A left list of known runtime kinds (grouped Ready / CLI needed, per
 * `lib/runtimes/catalog.ts`'s honestly-cheap readiness check) and a right
 * detail pane, matching the reference screenshots' shape. Selecting an entry
 * never creates anything by itself — it calls `onPick` with a pre-fill and
 * closes, and `AddRuntimeProfileForm` (the only thing that actually calls
 * `createRuntimeProfile`) puts those values in its own editable fields. A
 * person who already knows their command skips this dialog entirely via
 * "Enter it manually instead".
 */
export function RuntimeCatalogPicker({
  open,
  onOpenChange,
  probedCommandLines,
  onPick,
  onManual,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Command lines (see `catalogEntryCommandLine`) of this workspace's
   * existing runtime profiles whose last probe came back `ok`. Read-only
   * cross-reference — never a new detection path, see the catalog's own
   * header comment for why. */
  probedCommandLines: ReadonlySet<string>
  onPick: (selection: { name: string; protocolFamily: RuntimeProfile['protocolFamily']; commandLine: string }) => void
  onManual: () => void
}) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(RUNTIME_CATALOG[0]?.id ?? null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return RUNTIME_CATALOG
    return RUNTIME_CATALOG.filter(
      (entry) =>
        entry.displayName.toLowerCase().includes(q) ||
        entry.command.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q),
    )
  }, [search])

  const ready = useMemo(() => filtered.filter((e) => isCatalogEntryReady(e, probedCommandLines)), [filtered, probedCommandLines])
  const needsSetup = useMemo(
    () => filtered.filter((e) => !isCatalogEntryReady(e, probedCommandLines)),
    [filtered, probedCommandLines],
  )

  const selected = filtered.find((e) => e.id === selectedId) ?? filtered[0] ?? null

  function close() {
    onOpenChange(false)
    setSearch('')
  }

  function pick(entry: RuntimeCatalogEntry) {
    onPick({ name: entry.displayName, protocolFamily: entry.protocolFamily, commandLine: catalogEntryCommandLine(entry) })
    close()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(next) : close())}>
      <DialogContent className="max-w-2xl gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="gap-1 p-4 pb-3">
          <DialogTitle>Add a runtime</DialogTitle>
          <DialogDescription>
            Pick a known runtime kind to pre-fill its command below, or skip straight to entering your own. This list
            only describes how to reach a runtime — what it can actually do is never known until it answers its own
            handshake, after you add and probe it.
          </DialogDescription>
        </DialogHeader>

        <div className="px-4">
          <div className="relative">
            <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-black/35 dark:text-white/35" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search runtimes…"
              className="pl-8"
            />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-[13rem_1fr] border-t border-black/10 dark:border-white/10">
          <div className="max-h-96 overflow-y-auto border-r border-black/10 p-2 dark:border-white/10">
            {filtered.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-faint">No runtime matches &ldquo;{search}&rdquo;.</p>
            )}
            {ready.length > 0 && <GroupLabel>Ready</GroupLabel>}
            {ready.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                ready
                selected={entry.id === selected?.id}
                onSelect={() => setSelectedId(entry.id)}
              />
            ))}
            {needsSetup.length > 0 && <GroupLabel>CLI needed</GroupLabel>}
            {needsSetup.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                ready={false}
                selected={entry.id === selected?.id}
                onSelect={() => setSelectedId(entry.id)}
              />
            ))}
          </div>

          <div className="min-h-64 p-4">
            {selected ? (
              <DetailPane entry={selected} ready={isCatalogEntryReady(selected, probedCommandLines)} onPick={() => pick(selected)} />
            ) : (
              <p className="text-sm text-faint">Select a runtime on the left.</p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-black/10 p-3 dark:border-white/10">
          <p className="text-xs text-faint">Already know your command?</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onManual()
              close()
            }}
          >
            Enter it manually instead
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="mt-2 px-2 pb-1 text-[10px] font-medium tracking-wide text-faint uppercase first:mt-0">{children}</p>
}

function CatalogRow({
  entry,
  ready,
  selected,
  onSelect,
}: {
  entry: RuntimeCatalogEntry
  ready: boolean
  selected: boolean
  onSelect: () => void
}) {
  const Icon = entry.icon
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        selected ? 'bg-black/[0.05] dark:bg-white/[0.08]' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'
      }`}
    >
      <Icon size={14} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate">{entry.displayName}</span>
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${ready ? 'bg-emerald-500' : 'bg-black/15 dark:bg-white/15'}`}
        title={ready ? 'Ready' : 'CLI needed'}
      />
    </button>
  )
}

function DetailPane({ entry, ready, onPick }: { entry: RuntimeCatalogEntry; ready: boolean; onPick: () => void }) {
  const Icon = entry.icon
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon size={18} />
          <h3 className="text-sm font-medium">{entry.displayName}</h3>
        </div>
        <Badge variant={ready ? 'secondary' : 'outline'} className={ready ? '' : 'text-faint'}>
          {ready ? 'Ready' : 'CLI needed — probe after adding'}
        </Badge>
      </div>

      <p className="text-sm text-faint">{entry.description}</p>

      <dl className="flex flex-col gap-1.5 text-xs">
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-faint">ID</dt>
          <dd className="min-w-0 flex-1 font-mono break-all">{catalogEntryCommandLine(entry)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-faint">Protocol</dt>
          <dd>{entry.protocolFamily.toUpperCase()}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-faint">Source</dt>
          <dd className="min-w-0 flex-1 text-faint">{entry.source}</dd>
        </div>
      </dl>

      {entry.commandConfidence === 'illustrative' && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          Unverified: nobody has installed or probed this CLI from this codebase. Treat the command above as a
          starting guess, not a fact — confirm it works after adding, via the probe button.
        </p>
      )}

      <div className="mt-auto pt-2">
        <Button type="button" size="sm" onClick={onPick}>
          Use this runtime
        </Button>
      </div>
    </div>
  )
}
