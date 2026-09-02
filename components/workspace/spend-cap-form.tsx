'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { updateSpendCap } from '@/app/(app)/workspace/[workspaceSlug]/settings/actions'
import { toast } from '@/hooks/use-toast'

// ROADMAP B7.2 (Batch B-6 "Finish") — real save path now that
// `spendCapCents` exists on `collections/Workspaces.ts` (paired with
// migrations/20260902_150000_spend_caps.ts, both applied together — see
// each file's own comment). One gap remains, stated here rather than
// implied to work: nothing in `lib/dispatcher/` (`app/api/dispatcher/tick/
// route.ts`, `lib/dispatcher/worker.ts`) checks this value before claiming/
// executing a run — "fail-closed" enforcement is unbuilt, saving the cap
// does not yet stop spend from exceeding it.
export function SpendCapForm({
  workspaceId,
  workspaceSlug,
  workspaceName,
  initialSpendCapCents,
}: {
  workspaceId: number
  workspaceSlug: string
  workspaceName: string
  initialSpendCapCents: number | null
}) {
  const [value, setValue] = useState(initialSpendCapCents != null ? (initialSpendCapCents / 100).toFixed(2) : '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const trimmed = value.trim()
    const cents = trimmed === '' ? null : Math.round(Number(trimmed) * 100)
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' })
      setSaving(false)
      return
    }
    try {
      const result = await updateSpendCap({ workspaceId, workspaceSlug, spendCapCents: cents })
      setValue(result.spendCapCents != null ? (result.spendCapCents / 100).toFixed(2) : '')
      toast({ title: result.spendCapCents != null ? `Spend cap set to $${(result.spendCapCents / 100).toFixed(2)}/mo` : 'Spend cap removed — uncapped' })
    } catch (error) {
      toast({ title: 'Could not save spend cap', description: error instanceof Error ? error.message : undefined, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-black/50 dark:text-white/50">$</span>
        <Input
          type="number"
          min={0}
          step="0.01"
          placeholder="Uncapped"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={saving}
          className="w-32"
        />
        <span className="text-xs text-black/50 dark:text-white/50">/ month for {workspaceName}</span>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-black/45 dark:text-white/45">
        Saved, but not yet enforced: the dispatcher (<code>lib/dispatcher/worker.ts</code>) doesn&apos;t check this
        value before claiming or executing a run yet, so spend can still exceed the cap. Fail-closed enforcement is a
        real, separate gap — this only records the number for now.
      </p>
    </div>
  )
}
