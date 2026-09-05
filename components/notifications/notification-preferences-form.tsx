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
import { Volume2 } from 'lucide-react'
import { updateNotificationPreferences, type NotificationPreferencesView } from '@/app/(app)/settings/notifications/actions'
import { broadcastApprovalBellPreference, playApprovalBell } from '@/lib/notifications/approval-bell'
import { Button } from '@/components/ui/button'

const ROWS: Array<{ key: keyof NotificationPreferencesView; label: string; description: string }> = [
  { key: 'pushApprovals', label: 'Approvals', description: 'Push a notification when a new approval needs you.' },
  { key: 'pushCompletions', label: 'Completions', description: 'Push a notification when one of your runs finishes or fails.' },
  { key: 'pushMentions', label: 'Mentions', description: 'Push a notification when someone @mentions you.' },
  {
    key: 'soundOnApprovals',
    label: 'Chime when an agent needs my decision',
    description:
      'Play a short bell in the open app when an agent asks you for a decision or a permission. Works wherever the app is open; browsers only allow sound after you have clicked something on the page.',
  },
  { key: 'emailDigestEnabled', label: 'Daily email digest', description: 'Opt in to a daily email summarizing pending approvals and completions. Sending is not wired up yet — see this page for details.' },
]

export function NotificationPreferencesForm({ initial }: { initial: NotificationPreferencesView }) {
  const [prefs, setPrefs] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<'played' | 'blocked' | null>(null)

  function toggle(key: keyof NotificationPreferencesView) {
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    setError(null)
    // The shell's poller keeps its own copy of this one, so tell it now
    // rather than making the person reload to hear the change.
    if (key === 'soundOnApprovals') {
      broadcastApprovalBellPreference(next.soundOnApprovals)
      // Turning it on is a click, which is exactly the gesture browsers
      // want before they let a page make a sound — so play it once here,
      // both as a preview and to arm audio for later.
      if (next.soundOnApprovals) void playApprovalBell()
    }
    startTransition(async () => {
      try {
        await updateNotificationPreferences({ [key]: next[key] })
      } catch (err) {
        setPrefs(prefs) // revert on failure
        if (key === 'soundOnApprovals') broadcastApprovalBellPreference(prefs.soundOnApprovals)
        setError(err instanceof Error ? err.message : 'Failed to save.')
      }
    })
  }

  async function testSound() {
    setTestResult((await playApprovalBell()) ? 'played' : 'blocked')
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
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium text-foreground">{row.label}</span>
            <span className="text-xs text-muted-foreground">{row.description}</span>
            {row.key === 'soundOnApprovals' && (
              <span className="mt-1.5 flex items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={(event) => {
                    // The row is a <label>: a click on this button would
                    // also toggle the checkbox.
                    event.preventDefault()
                    void testSound()
                  }}
                >
                  <Volume2 size={12} />
                  Play the chime
                </Button>
                {testResult === 'played' && <span className="text-[11px] text-muted-foreground">Played.</span>}
                {testResult === 'blocked' && (
                  <span className="text-[11px] text-destructive">
                    This browser would not play sound. It may not support Web Audio, or it is muting this tab.
                  </span>
                )}
              </span>
            )}
          </span>
        </label>
      ))}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
