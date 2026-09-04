'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'
import { clearProviderKey, switchActiveProvider, updateProviderKey } from '@/app/(app)/workspace/[workspaceSlug]/settings/providers/actions'
import { unwrap } from '@/lib/failures'
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
  const [saving, setSaving] = useState(false)
  // `key` on the editing section (below) remounts these on a profile change,
  // so the form always reflects the profile actually being edited rather than
  // carrying the previous one's selection over.
  const profileLabel = selectedProfile || 'Install default'

  const keyByProvider = useMemo(() => new Map(keyStatus.map((k) => [k.provider, k])), [keyStatus])
  const modelsForProvider = providers.find((p) => p.provider === provider)?.models ?? []

  async function handleSwitch() {
    if (!provider.trim() || !model.trim()) return
    setSaving(true)
    try {
      unwrap(await switchActiveProvider({ workspaceSlug, provider, model, profile: selectedProfile }))
      toast({
        title: `${profileLabel}: switched to ${provider} / ${model}`,
        description: 'Backed up config.yaml before writing; every other line left untouched.',
      })
      router.refresh()
    } catch (err) {
      toast({
        title: 'Could not switch provider',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
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
        {active ? (
          <div className="mt-2 text-sm">
            <p>
              <span className="text-black/50 dark:text-white/50">Provider:</span> {active.provider}
            </p>
            <p>
              <span className="text-black/50 dark:text-white/50">Model:</span> {active.model}
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
          {envSlots.map((slot) => (
            <ProviderKeyRow key={slot.envKeyName} workspaceSlug={workspaceSlug} slot={slot} />
          ))}
          {envSlots.length === 0 && (
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
            disabled={saving || !provider || !model || (provider === active?.provider && model === active?.model)}
            onClick={() => void handleSwitch()}
          >
            {saving ? 'Switching…' : 'Switch'}
          </Button>
        </div>
      </section>
    </div>
  )
}

function ProviderKeyRow({ workspaceSlug, slot }: { workspaceSlug: string; slot: ProviderEnvSlot }) {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!value.trim()) return
    setBusy(true)
    try {
      unwrap(await updateProviderKey({ workspaceSlug, envKeyName: slot.envKeyName, value }))
      toast({ title: `${slot.envKeyName} updated` })
      setValue('')
      router.refresh()
    } catch (err) {
      toast({
        title: 'Could not save key',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    setBusy(true)
    try {
      unwrap(await clearProviderKey({ workspaceSlug, envKeyName: slot.envKeyName }))
      toast({ title: `${slot.envKeyName} cleared` })
      router.refresh()
    } catch (err) {
      toast({
        title: 'Could not clear key',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

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
      <Button type="button" size="sm" variant="outline" disabled={busy || !value.trim()} onClick={() => void save()}>
        Save
      </Button>
      {slot.configured && (
        <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void clear()}>
          Clear
        </Button>
      )}
    </div>
  )
}
