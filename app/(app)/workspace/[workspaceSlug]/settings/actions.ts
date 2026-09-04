'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { raise } from '@/lib/failures'
import { requireAccess } from '@/lib/permissions'

// ROADMAP B7.2 (Batch B-6 "Finish") — the real save path for the spend cap,
// completing the gap SpendCapForm's own comment flagged: the
// `spendCapCents` field now exists (collections/Workspaces.ts, paired with
// migrations/20260902_150000_spend_caps.ts, both applied together). This
// only persists the cap — dispatcher-side fail-closed enforcement
// (app/api/dispatcher/tick/route.ts / lib/dispatcher/worker.ts refusing to
// claim/execute a new run once a workspace is over budget) is a separate,
// still-unbuilt gap, not implied to work by this action existing.
//
// PHASE 0 — this had NO session check and no permission check of any kind. A
// server action is a public POST endpoint with a generated URL, not a private
// function: anyone who could reach the host and name a workspace id could set
// or clear that workspace's spend cap. `administer` rather than `write`,
// because `lib/permissions/model.ts` defines that verb as exactly this —
// "configuration that costs money or reaches outside" — so a `member` may work
// in a workspace without being able to raise its bill.
//
// R12-P1.1 — STILL not converted to `guard()`/`WithFailure`, and still for
// ownership rather than oversight: the only caller,
// `components/workspace/spend-cap-form.tsx`, belongs to another unit and reads
// `result.spendCapCents` directly, so widening the return type would break its
// compile without its owner being able to fix it in the same pass. So the
// refusal below still throws and that form's toast still shows React's generic
// sentence in production rather than "You are a member here, which cannot
// change the settings of this workspace." The check is enforced either way —
// what is lost is only the wording — and this stays tracked, not forgotten.
export async function updateSpendCap({
  workspaceId,
  workspaceSlug,
  spendCapCents,
}: {
  workspaceId: number
  workspaceSlug: string
  spendCapCents: number | null
}): Promise<{ spendCapCents: number | null }> {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You are not signed in.')
  await requireAccess({ userId: user.id, workspaceId, verb: 'administer', objectType: 'workspace' })

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
