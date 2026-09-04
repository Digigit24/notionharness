'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDown, ArrowUp, Check, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  getModelOptionsFor,
  setFallbackProviders,
  setProfileActiveModel,
  type FallbackEntry,
  type ModelSettings,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/model/actions'
import { unwrap } from '@/lib/failures'
import type { ServeModelOptions } from '@/lib/runtimes/hermes/serve-client'

/**
 * Active model, and the fallback order Hermes tries when it fails.
 *
 * Both are per PROFILE, not per workspace, because a profile is a complete
 * HERMES_HOME with its own config — which is exactly how an agent gets its
 * own model. The profile switcher at the top is therefore the primary
 * control, not a detail: changing the model here changes it for every agent
 * bound to that profile, and for no others.
 */
export function ModelSettingsView({
  workspaceSlug,
  settings,
}: {
  workspaceSlug: string
  settings: ModelSettings
}) {
  const router = useRouter()
  const [busy, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(settings.error)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmModel, setConfirmModel] = useState<{ provider: string; model: string; message: string } | null>(null)

  const [provider, setProvider] = useState(settings.info?.provider ?? '')
  const [model, setModel] = useState(settings.info?.model ?? '')
  const [fallbacks, setFallbacks] = useState<FallbackEntry[]>(settings.fallbacks)

  // The provider catalogue arrives AFTER first paint. Fetching it server-side
  // meant the page sat on skeletons until a cold runtime had woken and every
  // provider had answered — observed live as a model page that never loaded.
  // The current model and the fallback list render immediately; only the
  // pickers wait, and they say so.
  const [options, setOptions] = useState<ServeModelOptions | null>(settings.options)
  const [optionsLoading, setOptionsLoading] = useState(settings.options === null)
  useEffect(() => {
    if (settings.options !== null) return
    let cancelled = false
    setOptionsLoading(true)
    getModelOptionsFor(settings.profile)
      .then((result) => {
        if (!cancelled) setOptions(result)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setOptionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [settings.profile, settings.options])

  const providers = useMemo(() => options?.providers ?? [], [options])
  const modelsForProvider = useMemo(
    () => providers.find((p) => p.slug === provider)?.models ?? [],
    [providers, provider],
  )

  function switchProfile(next: string) {
    const url = next
      ? `/workspace/${workspaceSlug}/settings/model?profile=${encodeURIComponent(next)}`
      : `/workspace/${workspaceSlug}/settings/model`
    router.push(url)
  }

  function applyModel(confirmExpensive = false) {
    if (!provider || !model) return
    setError(null)
    setNotice(null)
    startTransition(async () => {
      try {
        const result = unwrap(
          await setProfileActiveModel({
            workspaceSlug,
            profile: settings.profile,
            provider,
            model,
            confirmExpensive,
          }),
        )
        if (result.confirm_required) {
          // Hermes answers an expensive model with a question, not an error.
          // Passing that through as a prompt is the difference between a
          // deliberate choice and a silent no-op.
          setConfirmModel({ provider, model, message: result.confirm_message ?? 'This model is expensive.' })
          return
        }
        setConfirmModel(null)
        setNotice(`Active model is now ${result.provider ?? provider} / ${result.model ?? model}.`)
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not change the model.')
      }
    })
  }

  function saveFallbacks(next: FallbackEntry[]) {
    setFallbacks(next)
    setError(null)
    startTransition(async () => {
      try {
        setFallbacks(unwrap(await setFallbackProviders({ workspaceSlug, profile: settings.profile, entries: next })))
        setNotice('Fallback order saved.')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save the fallback order.')
      }
    })
  }

  const move = (index: number, delta: number) => {
    const next = [...fallbacks]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    saveFallbacks(next)
  }

  return (
    <main className="w-full max-w-3xl px-5 py-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Model &amp; fallbacks</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          Which model answers, and what Hermes tries when it cannot. Both belong to a profile, so an agent
          bound to that profile inherits them.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        {settings.profiles.map((entry) => {
          const key = entry.is_default ? '' : entry.name
          const active = key === settings.profile
          return (
            <button
              key={entry.name}
              type="button"
              onClick={() => switchProfile(key)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                active
                  ? 'border-black/25 bg-black/[0.06] font-medium dark:border-white/25 dark:bg-white/[0.09]'
                  : 'border-black/10 hover:border-black/20 dark:border-white/10 dark:hover:border-white/20'
              }`}
            >
              {entry.is_default ? 'Install default' : entry.name}
              {entry.model && <span className="ml-1.5 text-black/35 dark:text-white/35">{entry.model}</span>}
            </button>
          )
        })}
      </div>

      {error && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          {notice}
        </p>
      )}

      <section className="mb-6 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Active model</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          {settings.info
            ? `Currently ${settings.info.provider} / ${settings.info.model}`
            : 'Hermes did not report a current model.'}
          {settings.info?.effective_context_length
            ? ` · ${settings.info.effective_context_length.toLocaleString('en-GB')} token context`
            : ''}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            value={provider || undefined}
            onValueChange={(v) => {
              setProvider(v)
              setModel('')
            }}
          >
            <SelectTrigger size="sm" className="w-52 text-xs">
              <SelectValue placeholder={optionsLoading ? 'Loading providers…' : 'Provider'} />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.slug} value={p.slug}>
                  {p.name}
                  {!p.authenticated ? ' (no key)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={model || undefined} onValueChange={setModel} disabled={!provider}>
            <SelectTrigger size="sm" className="w-64 text-xs">
              <SelectValue placeholder={provider ? 'Model' : 'Pick a provider first'} />
            </SelectTrigger>
            <SelectContent>
              {modelsForProvider.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button size="sm" disabled={busy || !provider || !model} onClick={() => applyModel()}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Apply
          </Button>
        </div>

        {confirmModel && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="flex items-start gap-1.5">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              {confirmModel.message}
            </p>
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => applyModel(true)} disabled={busy}>
                Use it anyway
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmModel(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Fallback order</h2>
            <p className="mt-1 text-xs text-black/50 dark:text-white/50">
              Tried top to bottom when the active model fails — a rate limit, an outage, a model that no
              longer exists. Order is the whole point, so this list saves as a list.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              setFallbacks((current) => [...current, { provider: providers[0]?.slug ?? '', model: '' }])
            }
          >
            <Plus size={12} />
            Add
          </Button>
        </div>

        {fallbacks.length === 0 && (
          <p className="mt-3 text-xs text-black/40 dark:text-white/40">
            No fallbacks. A failed call returns the error straight to the conversation.
          </p>
        )}

        <ol className="mt-3 space-y-1.5">
          {fallbacks.map((entry, index) => {
            const entryModels = providers.find((p) => p.slug === entry.provider)?.models ?? []
            return (
              <li
                key={`${entry.provider}-${entry.model}-${index}`}
                className="flex flex-wrap items-center gap-1.5 rounded-md border border-black/10 px-2 py-1.5 dark:border-white/10"
              >
                <span className="w-5 shrink-0 text-center text-[11px] text-black/35 dark:text-white/35">
                  {index + 1}
                </span>

                <Select
                  value={entry.provider || undefined}
                  onValueChange={(v) =>
                    setFallbacks((current) =>
                      current.map((row, i) => (i === index ? { ...row, provider: v, model: '' } : row)),
                    )
                  }
                >
                  <SelectTrigger size="sm" className="w-40 text-xs">
                    <SelectValue placeholder={optionsLoading ? 'Loading providers…' : 'Provider'} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.slug} value={p.slug}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {entryModels.length > 0 ? (
                  <Select
                    value={entry.model || undefined}
                    onValueChange={(v) =>
                      setFallbacks((current) => current.map((row, i) => (i === index ? { ...row, model: v } : row)))
                    }
                  >
                    <SelectTrigger size="sm" className="w-56 text-xs">
                      <SelectValue placeholder="Model" />
                    </SelectTrigger>
                    <SelectContent>
                      {entryModels.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  // A provider Hermes has no cached model list for still needs
                  // to be usable — typing the id is better than being stuck.
                  <input
                    value={entry.model}
                    onChange={(e) =>
                      setFallbacks((current) =>
                        current.map((row, i) => (i === index ? { ...row, model: e.target.value } : row)),
                      )
                    }
                    placeholder="model id"
                    className="w-56 rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
                  />
                )}

                <span className="ml-auto flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={index === 0 || busy}
                    onClick={() => move(index, -1)}
                    className="rounded p-1 hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={index === fallbacks.length - 1 || busy}
                    onClick={() => move(index, 1)}
                    className="rounded p-1 hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove"
                    disabled={busy}
                    onClick={() => saveFallbacks(fallbacks.filter((_, i) => i !== index))}
                    className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            )
          })}
        </ol>

        {fallbacks.length > 0 && (
          <Button
            size="sm"
            className="mt-3"
            disabled={busy}
            onClick={() => saveFallbacks(fallbacks)}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Save order
          </Button>
        )}
      </section>
    </main>
  )
}
