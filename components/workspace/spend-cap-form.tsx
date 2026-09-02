'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// ROADMAP B7.2 (Batch B-6 "Finish") — a real form skeleton for the spend
// cap, deliberately shipped DISABLED rather than wired to a Server Action
// that pretends to save. Two real gaps, both stated here instead of hidden
// behind a form that looks functional:
//   1. No `spendCapCents` field exists on `collections/Workspaces.ts` yet —
//      only the migration is written (migrations/20260902_150000_spend_caps.ts,
//      NOT applied). Adding the field before that migration runs would break
//      every workspace read in the app (`workspaces` is on the hot path —
//      `getWorkspaceBySlug` runs on nearly every page load), per this
//      session's established schema-drift discipline (see AGENTS.md and
//      migrations/20260902_100000_pages_project.ts for the identical
//      reasoning applied to `pages.project_id`).
//   2. Even once the field exists, nothing in `lib/dispatcher/`
//      (`app/api/dispatcher/tick/route.ts`, `lib/dispatcher/worker.ts`)
//      checks it before claiming/executing a run — "fail-closed" enforcement
//      is unbuilt, not just unwired. Both are flagged, not silently implied
//      to already work.
export function SpendCapForm({ workspaceName }: { workspaceName: string }) {
  const [value, setValue] = useState('')

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
          disabled
          className="w-32"
        />
        <span className="text-xs text-black/50 dark:text-white/50">/ month for {workspaceName}</span>
        <Button type="button" size="sm" variant="outline" disabled>
          Save
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-black/45 dark:text-white/45">
        Not wired yet. Saving requires the field to be added to <code>collections/Workspaces.ts</code> together with
        applying <code>migrations/20260902_150000_spend_caps.ts</code> (schema-drift discipline — see AGENTS.md), and
        the dispatcher (<code>lib/dispatcher/worker.ts</code>) still needs to actually check the cap and refuse a new
        run once it&apos;s exceeded. This form is the intended shape, not a working switch.
      </p>
    </div>
  )
}
