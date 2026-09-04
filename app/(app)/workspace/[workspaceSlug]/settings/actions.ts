'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'

// ROADMAP B7.2 (Batch B-6 "Finish") — the real save path for the spend cap,
// completing the gap SpendCapForm's own comment flagged: the
// `spendCapCents` field now exists (collections/Workspaces.ts, paired with
// migrations/20260902_150000_spend_caps.ts, both applied together). This
// only persists the cap — dispatcher-side fail-closed enforcement
// (app/api/dispatcher/tick/route.ts / lib/dispatcher/worker.ts refusing to
// claim/execute a new run once a workspace is over budget) is a separate,
// still-unbuilt gap, not implied to work by this action existing.
//
// R12-P1.1 — deliberately NOT converted to `guard()`/`WithFailure` yet, and
// the reason is ownership, not oversight. Its only caller is
// `components/workspace/spend-cap-form.tsx`, which belongs to another unit;
// changing this signature would break that file's compile without its owner
// being able to fix it in the same pass, which is the flag day the envelope
// design exists to avoid (see `lib/failures.ts`). So this still throws, and
// that form's "Could not save spend cap" toast still shows React's generic
// sentence in production rather than the real one — tracked, not forgotten.
export async function updateSpendCap({
  workspaceId,
  workspaceSlug,
  spendCapCents,
}: {
  workspaceId: number
  workspaceSlug: string
  spendCapCents: number | null
}): Promise<{ spendCapCents: number | null }> {
  const payload = await getPayloadClient()
  const updated = await payload.update({
    collection: 'workspaces',
    id: workspaceId,
    data: { spendCapCents },
    overrideAccess: true,
  })
  revalidatePath(`/workspace/${workspaceSlug}/settings`)
  return { spendCapCents: updated.spendCapCents ?? null }
}
