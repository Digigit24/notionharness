'use client'

import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'
import { unwrap } from '@/lib/failures'
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard'
import { sessionConfigOptions, type AgentHandshake } from '@/lib/runtimes/handshake'
import { RuntimeConfigFields } from '@/components/runtimes/runtime-config-fields'
import { saveRuntimeDefaults } from '@/app/(app)/workspace/[workspaceSlug]/settings/runtimes/actions'

/**
 * R12-P4.1/P4.2 — what this runtime does unless an agent says otherwise.
 *
 * THE PROBLEM THIS REMOVES. Until now the only place a session setting could
 * live was `agents.runtimeConfig`, so "which model does Claude Code use here"
 * had to be answered once per agent. Ten agents meant setting it ten times,
 * and a new agent silently inherited whatever the CLI's own default happened
 * to be rather than what this workspace had chosen everywhere else.
 *
 * THE REASON THERE IS NO CLAUDE-SPECIFIC CODE HERE. `RuntimeConfigFields`
 * renders whatever options a runtime declared about ITSELF during the ACP
 * handshake — for Claude Code that is `model`, `effort`, `fast` and `mode`.
 * That is D2 paying out: a runtime that ships a new option gets an editor for
 * it at the next probe, with no release-chasing on our side and no model list
 * we maintain. The same component already backs the agent editor, so the two
 * screens cannot drift.
 *
 * A runtime that has never been probed has nothing to declare, and this says
 * so rather than rendering an empty box — "probe it first" is the actionable
 * sentence, and it is the same one the probe button acts on.
 */
export function RuntimeDefaultsForm({
  workspaceSlug,
  profileId,
  handshake,
  initialValues,
}: {
  workspaceSlug: string
  profileId: number
  handshake: AgentHandshake | null
  /** `{ [configId]: value }`. An id absent here means "whatever the runtime
   * itself defaults to", which is a real choice and not the same as pinning
   * the value that happens to be its default today. */
  initialValues: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>(initialValues)
  // R12-P4.6 — what the last successful save actually wrote, so the guard
  // below stops thinking the form is dirty the moment a save succeeds. Kept
  // separate from the `initialValues` PROP for the same reason the spend cap
  // form's `savedValue` is: this component never re-renders with a fresh
  // prop after its own save, so comparing against the prop forever would
  // leave the guard permanently tripped after the first edit.
  const [savedValues, setSavedValues] = useState<Record<string, unknown>>(initialValues)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Before the early returns below: hooks cannot be conditional, and a
  // runtime that has not been probed yet can still, in principle, have this
  // form mounted before its handshake arrives.
  useUnsavedChangesGuard(JSON.stringify(values) !== JSON.stringify(savedValues))

  const options = sessionConfigOptions(handshake)

  if (!options) {
    return (
      <p className="text-xs text-faint">
        This runtime has not been probed yet, so it has not said what it can be configured with. Probe it and its
        own settings will appear here.
      </p>
    )
  }
  if (options.length === 0) {
    // Genuinely different from "not probed": the runtime answered, and its
    // answer was that it has no session settings. Saying that closes the
    // question instead of leaving someone probing again.
    return <p className="text-xs text-faint">This runtime declares no session settings.</p>
  }

  async function save(next: Record<string, unknown>) {
    setSaving(true)
    setSaved(false)
    try {
      unwrap(await saveRuntimeDefaults({ workspaceSlug, profileId, defaults: next }))
      setSavedValues(next)
      setSaved(true)
    } catch (error) {
      toast({
        title: 'Those defaults were not saved',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const summary = Object.entries(values)
    .map(([id, value]) => {
      const option = options.find((candidate) => candidate.id === id)
      const label = option?.name ?? id
      const chosen = option?.options?.find((candidate) => candidate.value === value)
      return `${label}: ${chosen?.name ?? String(value)}`
    })
    .join(' · ')

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 self-start text-xs text-faint hover:text-foreground"
      >
        <Settings2 size={12} />
        {/* The summary is the point of the collapsed state: "what does this
            runtime do by default" should be answerable without opening
            anything. */}
        {summary.length > 0 ? `Defaults — ${summary}` : 'Defaults — using this runtime’s own'}
      </button>

      {open && (
        <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
          <RuntimeConfigFields
            options={options}
            values={values}
            onChange={setValues}
            disabled={saving}
          />
          <p className="text-[11px] text-faint">
            Every agent on this runtime inherits these unless it sets its own, and a per-message override still
            wins over both.
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" size="xs" disabled={saving} onClick={() => void save(values)}>
              {saving ? 'Saving…' : 'Save defaults'}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={saving || Object.keys(values).length === 0}
              onClick={() => {
                setValues({})
                void save({})
              }}
            >
              Clear
            </Button>
            {saved && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Saved</span>}
          </div>
        </div>
      )}
    </div>
  )
}
