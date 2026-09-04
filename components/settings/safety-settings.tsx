'use client'

import { useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProfilePills } from './profile-pills'
import { APPROVAL_MODES } from './approval-modes'
import {
  saveSafetySettings,
  type SafetyPath,
  type SafetySettings,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/safety/actions'
import { unwrap } from '@/lib/failures'

function asBool(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Approvals and memory limits for one Hermes profile. */
export function SafetySettingsView({
  workspaceSlug,
  settings,
}: {
  workspaceSlug: string
  settings: SafetySettings
}) {
  const [values, setValues] = useState<Partial<Record<SafetyPath, unknown>>>(settings.values)
  const [error, setError] = useState<string | null>(settings.error)
  const [saved, setSaved] = useState(false)
  const [busy, startTransition] = useTransition()

  const set = (path: SafetyPath, value: unknown) => {
    setValues((current) => ({ ...current, [path]: value }))
    setSaved(false)
  }

  function save() {
    setError(null)
    startTransition(async () => {
      try {
        unwrap(await saveSafetySettings({ workspaceSlug, profile: settings.profile, values }))
        setSaved(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save.')
      }
    })
  }

  const mode = typeof values['approvals.mode'] === 'string' ? (values['approvals.mode'] as string) : 'manual'

  return (
    <main className="w-full max-w-3xl px-5 py-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Safety &amp; memory</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          When an agent has to ask before acting, and how much it is allowed to remember. Per profile, like
          everything else Hermes owns.
        </p>
      </header>

      <ProfilePills
        profiles={settings.profiles}
        active={settings.profile}
        basePath={`/workspace/${workspaceSlug}/settings/safety`}
      />

      {error && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <section className="mb-5 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Approvals</h2>
        <div className="mt-2 space-y-1.5">
          {APPROVAL_MODES.map((entry) => (
            <label
              key={entry.value}
              className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition ${
                mode === entry.value
                  ? 'border-black/25 bg-black/[0.04] dark:border-white/25 dark:bg-white/[0.06]'
                  : 'border-black/10 hover:border-black/20 dark:border-white/10 dark:hover:border-white/20'
              }`}
            >
              <input
                type="radio"
                name="approvals-mode"
                className="mt-0.5"
                checked={mode === entry.value}
                onChange={() => set('approvals.mode', entry.value)}
              />
              <span>
                <span className="block text-xs font-medium">{entry.label}</span>
                <span className="block text-[11px] text-black/45 dark:text-white/45">{entry.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <label className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-black/60 dark:text-white/60">Give up waiting after</span>
          <input
            type="number"
            min={10}
            max={3600}
            value={asNumber(values['approvals.timeout'], 60)}
            onChange={(e) => set('approvals.timeout', Number(e.target.value))}
            className="w-20 rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
          />
          <span className="text-black/60 dark:text-white/60">seconds</span>
        </label>
      </section>

      <section className="mb-5 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Memory</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Limits apply to what Hermes folds into the system prompt. Per-agent entries live on each agent&apos;s
          own Memory tab.
        </p>

        <label className="mt-3 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={asBool(values['memory.memory_enabled'])}
            onChange={(e) => set('memory.memory_enabled', e.target.checked)}
          />
          Let agents keep their own notes
        </label>
        <label className="mt-1.5 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={asBool(values['memory.user_profile_enabled'])}
            onChange={(e) => set('memory.user_profile_enabled', e.target.checked)}
          />
          Let agents keep a profile of you
        </label>

        <div className="mt-3 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs">
            <span className="text-black/60 dark:text-white/60">Notes limit</span>
            <input
              type="number"
              min={0}
              step={500}
              value={asNumber(values['memory.memory_char_limit'], 6000)}
              onChange={(e) => set('memory.memory_char_limit', Number(e.target.value))}
              className="w-24 rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
            />
            <span className="text-black/40 dark:text-white/40">chars</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-black/60 dark:text-white/60">Profile limit</span>
            <input
              type="number"
              min={0}
              step={500}
              value={asNumber(values['memory.user_char_limit'], 4000)}
              onChange={(e) => set('memory.user_char_limit', Number(e.target.value))}
              className="w-24 rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
            />
            <span className="text-black/40 dark:text-white/40">chars</span>
          </label>
        </div>
      </section>

      <section className="mb-5 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Secrets</h2>
        <label className="mt-2 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={asBool(values['security.redact_secrets'])}
            onChange={(e) => set('security.redact_secrets', e.target.checked)}
          />
          Redact secrets from tool output and logs
        </label>
      </section>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Save
        </Button>
        {saved && !busy && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            Saved. New sessions pick this up; a turn already running keeps its old settings.
          </span>
        )}
      </div>
    </main>
  )
}
