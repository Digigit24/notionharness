'use client'

// ROADMAP B5.3 (Batch B-5 "Attention") — the actual per-event toggle UI.
// Plain native checkboxes (this repo's components/ui/* has no Switch/
// Checkbox primitive yet — confirmed by listing the directory) styled with
// the same token classes (border-border, text-foreground, etc.) every other
// component here uses, rather than a hardcoded color. Each toggle writes
// through immediately (no separate "Save" step) — same "no second source of
// truth" posture as the rest of this app's inline-editable controls (e.g.
// components/tasks/task-list-view.tsx's inline status/assignee selects).
import { useState, useTransition } from 'react'
import { updateNotificationPreferences, type NotificationPreferencesView } from '@/app/(app)/settings/notifications/actions'

const ROWS: Array<{ key: keyof NotificationPreferencesView; label: string; description: string }> = [
  { key: 'pushApprovals', label: 'Approvals', description: 'Push a notification when a new approval needs you.' },
  { key: 'pushCompletions', label: 'Completions', description: 'Push a notification when one of your runs finishes or fails.' },
  { key: 'pushMentions', label: 'Mentions', description: 'Push a notification when someone @mentions you.' },
  { key: 'emailDigestEnabled', label: 'Daily email digest', description: 'Opt in to a daily email summarizing pending approvals and completions. Sending is not wired up yet — see this page for details.' },
]

export function NotificationPreferencesForm({ initial }: { initial: NotificationPreferencesView }) {
  const [prefs, setPrefs] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle(key: keyof NotificationPreferencesView) {
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    setError(null)
    startTransition(async () => {
      try {
        await updateNotificationPreferences({ [key]: next[key] })
      } catch (err) {
        setPrefs(prefs) // revert on failure
        setError(err instanceof Error ? err.message : 'Failed to save.')
      }
    })
  }

  return (
    <div className="flex flex-col gap-1">
      {ROWS.map((row) => (
        <label
          key={row.key}
          className="flex cursor-pointer items-start gap-3 rounded-md border border-transparent px-2 py-2 hover:border-border hover:bg-muted"
        >
          <input
            type="checkbox"
            checked={prefs[row.key]}
            onChange={() => toggle(row.key)}
            disabled={pending}
            className="mt-0.5 size-4 shrink-0 rounded border-border accent-primary"
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">{row.label}</span>
            <span className="text-xs text-muted-foreground">{row.description}</span>
          </span>
        </label>
      ))}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
