import { NextResponse } from 'next/server'

import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'

/**
 * Phase 0 — the membership half of the Hermes proxy gate.
 *
 * WHAT THE AUDIT GOT WRONG. The enterprise handoff says all sixteen (there are
 * twenty) `/api/hermes/**` routes are unauthenticated. They are not, and have
 * not been since `4881157`: `lib/runtimes/hermes/api-proxy.ts`'s
 * `proxyToHermes` calls `getSession()` and answers `401 {"error":"Unauthorized"}`
 * before it touches anything. Confirmed live against a dev server on :3177 for
 * all seven read routes plus `POST skills/save` and `POST crons/run` — every
 * one 401.
 *
 * WHAT IS ACTUALLY MISSING is the second half of that sentence: membership.
 * A session proves somebody signed up; it does not prove they belong here.
 * Anyone who can reach the signup page becomes a user with a session and no
 * workspace, and that was enough to write a skill file into the Hermes install
 * (`skills/save`), delete one, and execute a cron job on this host
 * (`crons/run`). Those three are the reason this file exists; the read routes
 * are gated the same way only so there is one rule rather than a list of
 * exceptions to remember.
 *
 * MEMBERSHIP OF *SOME* WORKSPACE, NOT OF A NAMED ONE, and that is deliberate.
 * Hermes is a host-level singleton — one install, one set of skills, one cron
 * table — so no request here carries a workspace id and none could
 * meaningfully. `lib/permissions`'s `requireAccess` needs an object in a
 * workspace to answer about; there is no such object. Asking "is this person a
 * member of anything in this install" is the strongest question this surface
 * can actually answer, and pretending otherwise by inventing a workspace
 * parameter the client does not have would be a check that looks stronger than
 * it is.
 */
export async function requireHermesAccess(): Promise<Response | null> {
  const user = await getCurrentPayloadUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const payload = await getPayloadClient()
  const membership = await payload.count({
    collection: 'workspace-members',
    where: { user: { equals: user.id } },
    overrideAccess: true,
  })
  if (membership.totalDocs === 0) {
    return NextResponse.json(
      { error: 'You are not a member of any workspace, so you cannot reach the runtime.' },
      { status: 403 },
    )
  }
  return null
}
