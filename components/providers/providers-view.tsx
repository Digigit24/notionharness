'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'
import { clearProviderKey, switchActiveProvider, updateProviderKey } from '@/app/(app)/workspace/[workspaceSlug]/settings/providers/actions'
import { useOptimisticAction } from '@/lib/optimistic'
import type { ActiveModelConfig, ProviderEnvSlot, ProviderKeyStatus, ProviderModelInfo } from '@/lib/runtimes/hermes/providers'
import type { HermesProfileSummary } from '@/lib/runtimes/hermes/profiles'

export function ProvidersView({
  workspaceSlug,
  profiles,
  selectedProfile,
  active,
  providers,
  keyStatus,
  envSlots,
}: {
  workspaceSlug: string
  /** Every Hermes profile on this machine, including the install root as ''. */
  profiles: HermesProfileSummary[]
  /** Which profile this page is currently editing. '' = install root. */
  selectedProfile: string
  active: ActiveModelConfig | null
  providers: ProviderModelInfo[]
  keyStatus: ProviderKeyStatus[]
  envSlots: ProviderEnvSlot[]
}) {
  const router = useRouter()
  const [provider, setProvider] = useState(active?.provider ?? providers[0]?.provider ?? '')
  const [model, setModel] = useState(active?.model ?? '')
  // Mirrors `active` so "Currently active" updates the instant Switch is
  // clicked instead of waiting on `router.refresh()`'s full round trip (D0).
  // Resynced below on a profile change, since switching profiles navigates
  // within this same component instance rather than remounting it.
  const [activeState, setActiveState] = useState(active)
  const [, startBackgroundRefresh] = useTransition()
  const switchOptimistic = useOptimisticAction<void>()
  // `key` on the editing section (below) remounts these on a profile change,
  // so the form always reflects the profile actually being edited rather than
  // carrying the previous one's selection over.
  const profileLabel = selectedProfile || 'Install default'

  useEffect(() => {
    setActiveState(active)
    setProvider(active?.provider ?? providers[0]?.provider ?? '')
    setModel(active?.model ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProfile])

  // Mirrors `envSlots` so a key row's checkmark flips the instant Save/Clear
  // is clicked, same reasoning as `activeState` above.
  const [slots, setSlots] = useState(envSlots)
  useEffect(() => {
    setSlots(envSlots)
  }, [envSlots])

  const keyByProvider = useMemo(() => new Map(keyStatus.map((k) => [k.provider, k])), [keyStatus])
  const modelsForProvider = providers.find((p) => p.provider === provider)?.models ?? []

  function handleSwitch() {
    if (!provider.trim() || !model.trim()) return
    const previous = activeState
    void switchOptimistic.run({
      // Switching a provider/model never changes the base URL — that's a
      // per-connection setting, not per-model — so it just carries over.
      apply: () => setActiveState((current) => ({ baseUrl: current?.baseUrl ?? '', provider, model })),
      rollback: () => setActiveState(previous),
      work: () => switchActiveProvider({ workspaceSlug, provider, model, profile: selectedProfile }),
      failureTitle: 'Could not switch provider',
      onSettled: () => {
        toast({
          title: `${profileLabel}: switched to ${provider} / ${model}`,
          description: 'Backed up config.yaml before writing; every other line left untouched.',
        })
        // Background only — the sentence above and `activeState` already say
        // what changed; this just lets the rest of the page (e.g. an agent's
        // own model display elsewhere) catch up.
        startBackgroundRefresh(() => router.refresh())
      },
    })
  }

  return (
    <div className="space-y-6">
      {/* Profile switcher. Navigation rather than local state so the choice
          lives in the URL — linkable, reload-safe, and it lets the server read
          that profile's own config.yaml and model cache directly. */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Hermes profile</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Each profile is a complete Hermes home with its own model, credentials and persona. Agents pinned to a
          profile answer with that profile&apos;s model.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profiles.map((entry) => {
            const isActive = entry.name === selectedProfile
            return (
              <button
                key={entry.name || '__root__'}
                type="button"
                onClick={() => router.push(`/workspace/${workspaceSlug}/settings/providers?profile=${encodeURIComponent(entry.name)}`)}
                className={
                  isActive
                    ? 'rounded-full border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground'
                    : 'rounded-full border border-black/15 px-3 py-1.5 text-xs text-black/65 transition hover:bg-black/[0.04] dark:border-white/15 dark:text-white/65 dark:hover:bg-white/[0.06]'
                }
              >
                {entry.name || 'Install default'}
                <span className={isActive ? 'ml-1.5 opacity-70' : 'ml-1.5 text-black/35 dark:text-white/35'}>
                  {entry.model ?? 'no model'}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Currently active — {profileLabel}</h2>
        {activeState ? (
          <div className="mt-2 text-sm">
            <p>
              <span className="text-black/50 dark:text-white/50">Provider:</span> {activeState.provider}
            </p>
            <p>
              <span className="text-black/50 dark:text-white/50">Model:</span> {activeState.model}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-black/50 dark:text-white/50">
            Could not read Hermes&apos;s active model config (is HERMES_HOME_BASE set?).
          </p>
        )}
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Configured providers</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Whether an API key is present in Hermes&apos;s .env — names only, never the key itself.
        </p>
        <ul className="mt-3 space-y-1.5">
          {keyStatus.map((k) => (
            <li key={k.provider} className="flex items-center gap-2 text-sm">
              {k.configured ? (
                <CheckCircle2 size={14} className="text-green-600 dark:text-green-400" />
              ) : (
                <XCircle size={14} className="text-black/30 dark:text-white/30" />
              )}
              <span className="font-medium">{k.provider}</span>
              <span className="text-xs text-black/40 dark:text-white/40">
                {k.configured ? `${k.envKeyName} configured` : `${k.envKeyName} not set`}
              </span>
            </li>
          ))}
          {keyStatus.length === 0 && (
            <p className="text-sm text-black/40 dark:text-white/40">No providers found in Hermes&apos;s model cache.</p>
          )}
        </ul>
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Provider API keys</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Add or update a key directly — writes to Hermes&apos;s .env on this machine and backs it up first. A saved
          key is never shown again, only whether one is present.
        </p>
        <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
          {slots.map((slot) => (
            <ProviderKeyRow
              key={slot.envKeyName}
              workspaceSlug={workspaceSlug}
              slot={slot}
              onConfiguredChange={(configured) =>
                setSlots((current) =>
                  current.map((s) => (s.envKeyName === slot.envKeyName ? { ...s, configured } : s)),
                )
              }
            />
          ))}
          {slots.length === 0 && (
            <p className="text-sm text-black/40 dark:text-white/40">No provider key slots found in Hermes&apos;s .env.</p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Switch active provider / model</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Applies immediately to every agent (Hermes has one active model, not one per agent). Backs up config.yaml
          first.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v)
              setModel('')
            }}
          >
            <SelectTrigger size="sm" className="text-sm">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.provider} value={p.provider}>
                  {p.provider}
                  {keyByProvider.get(p.provider)?.configured === false ? ' (no key)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={model} onValueChange={setModel} disabled={modelsForProvider.length === 0}>
            <SelectTrigger size="sm" className="text-sm">
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent>
              {modelsForProvider.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-3">
          <Button
            type="button"
            size="sm"
            disabled={
              switchOptimistic.pending ||
              !provider ||
              !model ||
              (provider === activeState?.provider && model === activeState?.model)
            }
            onClick={handleSwitch}
          >
            {switchOptimistic.pending ? 'Switching…' : 'Switch'}
          </Button>
        </div>
      </section>
    </div>
  )
}

function ProviderKeyRow({
  workspaceSlug,
  slot,
  onConfiguredChange,
}: {
  workspaceSlug: string
  slot: ProviderEnvSlot
  /** Flips this row's OWN checkmark in the parent's `slots` mirror the
   * instant Save/Clear is clicked — see providers-view.tsx's header for why
   * that mirror exists instead of waiting on `router.refresh()`. */
  onConfiguredChange: (configured: boolean) => void
}) {
  const [value, setValue] = useState('')
  const { run, pending } = useOptimisticAction<void>()

  function save() {
    if (!value.trim()) return
    const submitted = value
    void run({
      apply: () => {
        onConfiguredChange(true)
        setValue('')
      },
      rollback: () => {
        onConfiguredChange(slot.configured)
        setValue(submitted)
      },
      work: () => updateProviderKey({ workspaceSlug, envKeyName: slot.envKeyName, value: submitted }),
      failureTitle: 'Could not save key',
      onSettled: () => toast({ title: `${slot.envKeyName} updated` }),
    })
  }

  function clear() {
    void run({
      apply: () => onConfiguredChange(false),
      rollback: () => onConfiguredChange(slot.configured),
      work: () => clearProviderKey({ workspaceSlug, envKeyName: slot.envKeyName }),
      failureTitle: 'Could not clear key',
      onSettled: () => toast({ title: `${slot.envKeyName} cleared` }),
    })
  }

  const busy = pending

  return (
    <div className="flex items-center gap-2">
      {slot.configured ? (
        <CheckCircle2 size={14} className="shrink-0 text-green-600 dark:text-green-400" />
      ) : (
        <XCircle size={14} className="shrink-0 text-black/30 dark:text-white/30" />
      )}
      <span className="w-44 shrink-0 truncate font-mono text-xs">{slot.envKeyName}</span>
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={slot.configured ? 'Update key…' : 'Enter key…'}
        className="min-w-0 flex-1 rounded border border-black/15 px-2 py-1 text-xs dark:border-white/15 dark:bg-white/[.04]"
      />
      <Button type="button" size="sm" variant="outline" disabled={busy || !value.trim()} onClick={save}>
        Save
      </Button>
      {slot.configured && (
        <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={clear}>
          Clear
        </Button>
      )}
    </div>
  )
}
