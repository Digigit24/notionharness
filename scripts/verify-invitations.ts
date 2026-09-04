/**
 * End-to-end proof of the people-management unit, against the live database.
 *
 * WHAT IT PROVES, and why each one is here rather than assumed:
 *
 *   1. An invitation is created with a pending status and a real expiry.
 *   2. A SECOND user accepts it, and BOTH membership writes land — the
 *      `workspace-members` row AND the legacy `workspaces.members` array entry.
 *      This is the single highest-risk detail in the unit: the workspace layout
 *      gates the entire shell on that array, so a row without an array entry is
 *      a person who cannot open the workspace they just joined.
 *   3. A wrong-email accept is REFUSED, with the sentence that names both
 *      addresses. A forwarded invite link handing out a seat is the classic
 *      invite-link privilege bug.
 *   4. Expired and revoked invitations are refused, with DIFFERENT messages.
 *   5. The last owner can be neither demoted nor removed.
 *   6. Audit rows are written for every one of those events.
 *
 * Everything it creates is torn down at the end, including on failure.
 */
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')
const invitations = await import('../lib/invitations')
const { isAppFailure } = await import('../lib/failures')

const STAMP = Date.now()
const INVITER_EMAIL = `verify-inviter-${STAMP}@example.test`
const INVITEE_EMAIL = `verify-invitee-${STAMP}@example.test`
const STRANGER_EMAIL = `verify-stranger-${STAMP}@example.test`
const SLUG = `verify-invites-${STAMP}`

let passes = 0
let failures = 0

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passes += 1
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Run something that is supposed to be refused and return the message. */
async function refusal(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work()
    return null
  } catch (err) {
    if (isAppFailure(err)) return `${err.code}: ${err.message}`
    return `threw: ${err instanceof Error ? err.message : String(err)}`
  }
}

const payload = await getPayloadClient()

const created: { users: number[]; workspace: number | null; channel: number | null } = {
  users: [],
  workspace: null,
  channel: null,
}

try {
  // --- Fixtures -------------------------------------------------------------

  const inviter = await payload.create({
    collection: 'users',
    data: { email: INVITER_EMAIL, name: 'Verify Inviter', role: 'member', password: `p${STAMP}Aa!` },
    overrideAccess: true,
  })
  const invitee = await payload.create({
    collection: 'users',
    data: { email: INVITEE_EMAIL, name: 'Verify Invitee', role: 'member', password: `p${STAMP}Bb!` },
    overrideAccess: true,
  })
  const stranger = await payload.create({
    collection: 'users',
    data: { email: STRANGER_EMAIL, name: 'Verify Stranger', role: 'member', password: `p${STAMP}Cc!` },
    overrideAccess: true,
  })
  created.users.push(inviter.id, invitee.id, stranger.id)

  const workspace = await payload.create({
    collection: 'workspaces',
    // `members` starts EMPTY on purpose, exactly as `createWorkspace` leaves it,
    // so the array entry this script checks for can only have come from
    // `addWorkspaceMember`.
    data: { name: `Verify ${STAMP}`, slug: SLUG, owner: inviter.id, members: [] },
    overrideAccess: true,
  })
  created.workspace = workspace.id

  await invitations.addWorkspaceMember({
    payload,
    workspaceId: workspace.id,
    userId: inviter.id,
    role: 'owner',
  })

  const channelRow = await getBrokerPool().query<{ id: number }>(
    `INSERT INTO teams (workspace_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [workspace.id, `verify-${STAMP}`, 'invitation verification', inviter.id],
  )
  // `Number(...)` is not cosmetic: `teams.id` is a bigint and node-postgres
  // returns bigints as STRINGS, so every `=== created.channel` below compares a
  // number against "98" and fails while the product is behaving correctly.
  created.channel = Number(channelRow.rows[0].id)

  console.log(
    `fixtures: workspace ${workspace.id} (${SLUG}), owner ${inviter.id}, invitee ${invitee.id}, stranger ${stranger.id}, channel ${created.channel}`,
  )

  // --- 1. Create the invitation --------------------------------------------

  const invite = await invitations.createInvitation({
    payload,
    workspaceId: workspace.id,
    email: INVITEE_EMAIL,
    role: 'member',
    invitedBy: inviter.id,
    channelId: created.channel,
  })
  check('invitation created as pending', invite.status === 'pending', `id ${invite.id}`)
  check('invitation carries a token', invite.token.length >= 32, `${invite.token.length} chars`)
  check('invitation has a future expiry', new Date(invite.expiresAt).getTime() > Date.now(), invite.expiresAt)
  check('invitation remembers the channel', invite.channelId === created.channel)

  // Re-inviting must refresh the SAME row rather than minting a second live
  // token for one seat.
  const reissued = await invitations.createInvitation({
    payload,
    workspaceId: workspace.id,
    email: INVITEE_EMAIL,
    role: 'member',
    invitedBy: inviter.id,
  })
  check('re-invite reuses the row', reissued.id === invite.id, `id ${reissued.id}`)
  check('re-invite rotates the token', reissued.token !== invite.token)
  check('re-invite keeps the channel', reissued.channelId === created.channel)

  // --- 2. A stranger cannot accept it --------------------------------------

  const wrongEmail = await refusal(() =>
    invitations.acceptInvitation({
      token: reissued.token,
      user: { id: stranger.id, email: STRANGER_EMAIL, name: 'Verify Stranger' },
    }),
  )
  check('wrong-email accept refused', wrongEmail !== null, wrongEmail ?? 'IT WAS ACCEPTED')
  check(
    'wrong-email refusal names both addresses',
    Boolean(wrongEmail && wrongEmail.includes(INVITEE_EMAIL) && wrongEmail.includes(STRANGER_EMAIL)),
  )

  const strangerRow = await payload.count({
    collection: 'workspace-members',
    where: { and: [{ workspace: { equals: workspace.id } }, { user: { equals: stranger.id } }] },
    overrideAccess: true,
  })
  check('stranger got no membership row', strangerRow.totalDocs === 0)

  // --- 3. The real invitee accepts -----------------------------------------

  const accepted = await invitations.acceptInvitation({
    token: reissued.token,
    user: { id: invitee.id, email: INVITEE_EMAIL, name: 'Verify Invitee' },
  })
  check('accept returns the workspace', accepted.workspaceSlug === SLUG, accepted.workspaceSlug)
  check('accept returns the role', accepted.role === 'member', accepted.role)
  check('accept joined the channel', accepted.channelId === created.channel, String(accepted.channelId))

  // THE PAIR. Both of these must be true or the member cannot open the
  // workspace they just joined.
  const memberRow = await payload.find({
    collection: 'workspace-members',
    where: { and: [{ workspace: { equals: workspace.id } }, { user: { equals: invitee.id } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  check('workspace-members row exists', memberRow.docs.length === 1, `role ${memberRow.docs[0]?.role}`)

  const reread = await payload.findByID({
    collection: 'workspaces',
    id: workspace.id,
    depth: 0,
    overrideAccess: true,
  })
  const legacy = (reread.members ?? []).map((m) => (typeof m === 'number' ? m : m.id))
  check('legacy workspaces.members contains the invitee', legacy.includes(invitee.id), `[${legacy.join(', ')}]`)
  check('legacy workspaces.members contains the owner', legacy.includes(inviter.id))

  // The layout's own test, run verbatim, because that is the failure this pair
  // exists to prevent.
  const ownerId = typeof reread.owner === 'number' ? reread.owner : reread.owner?.id
  check(
    'workspace layout would admit the invitee',
    ownerId === invitee.id || legacy.includes(invitee.id),
  )

  const slot = await getBrokerPool().query(
    `SELECT id, display_name FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [created.channel, invitee.id],
  )
  check('channel slot created for the invitee', slot.rowCount === 1)

  const consumed = await payload.findByID({
    collection: 'invitations',
    id: reissued.id,
    depth: 0,
    overrideAccess: true,
  })
  check('invitation marked accepted', consumed.status === 'accepted', consumed.status)
  check(
    'invitation records who accepted',
    (typeof consumed.acceptedBy === 'number' ? consumed.acceptedBy : consumed.acceptedBy?.id) === invitee.id,
  )

  const secondAccept = await refusal(() =>
    invitations.acceptInvitation({
      token: reissued.token,
      user: { id: invitee.id, email: INVITEE_EMAIL, name: 'Verify Invitee' },
    }),
  )
  check('a used token cannot be used again', secondAccept !== null, secondAccept ?? 'IT WAS ACCEPTED AGAIN')

  // --- 3b. What the accept SCREEN is told ----------------------------------
  //
  // `previewInvitation` is what `app/invite/[token]/page.tsx` branches on, and
  // its whole point is that each refusal gets its own `reason`. A screen that
  // renders one sentence for five different situations is the thing this
  // replaces, so the five are checked here rather than assumed from the accept
  // path above.

  const freshForPreview = await invitations.createInvitation({
    payload,
    workspaceId: workspace.id,
    email: `preview-${STAMP}@example.test`,
    role: 'viewer',
    invitedBy: inviter.id,
  })

  const signedOut = await invitations.previewInvitation(freshForPreview.token, null)
  check('preview for a signed-out visitor is not a refusal', signedOut?.reason === null, String(signedOut?.reason))
  check('preview names the workspace', signedOut?.workspaceName === `Verify ${STAMP}`, signedOut?.workspaceName)

  const wrongViewer = await invitations.previewInvitation(freshForPreview.token, {
    id: stranger.id,
    email: STRANGER_EMAIL,
  })
  check('preview flags a forwarded link as wrong_email', wrongViewer?.reason === 'wrong_email', String(wrongViewer?.reason))

  const usedPreview = await invitations.previewInvitation(reissued.token, { id: invitee.id, email: INVITEE_EMAIL })
  check('preview flags a used link as accepted', usedPreview?.reason === 'accepted', String(usedPreview?.reason))

  const unknownPreview = await invitations.previewInvitation('a-token-that-was-never-issued', null)
  check('preview returns null for an unknown token', unknownPreview === null)

  await invitations.revokeInvitation({
    payload,
    workspaceId: workspace.id,
    invitationId: freshForPreview.id,
    actorId: inviter.id,
  })
  const revokedPreview = await invitations.previewInvitation(freshForPreview.token, null)
  check('preview flags a revoked link as revoked', revokedPreview?.reason === 'revoked', String(revokedPreview?.reason))

  // --- 4. Expired and revoked, with different sentences ---------------------

  const expiring = await invitations.createInvitation({
    payload,
    workspaceId: workspace.id,
    email: `expired-${STAMP}@example.test`,
    role: 'viewer',
    invitedBy: inviter.id,
  })
  await payload.update({
    collection: 'invitations',
    id: expiring.id,
    data: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    overrideAccess: true,
  })
  const expiredMsg = await refusal(() =>
    invitations.acceptInvitation({
      token: expiring.token,
      user: { id: invitee.id, email: `expired-${STAMP}@example.test` },
    }),
  )
  check('expired invitation refused', expiredMsg !== null, expiredMsg ?? 'IT WAS ACCEPTED')

  const revoking = await invitations.createInvitation({
    payload,
    workspaceId: workspace.id,
    email: `revoked-${STAMP}@example.test`,
    role: 'viewer',
    invitedBy: inviter.id,
  })
  await invitations.revokeInvitation({
    payload,
    workspaceId: workspace.id,
    invitationId: revoking.id,
    actorId: inviter.id,
  })
  const revokedMsg = await refusal(() =>
    invitations.acceptInvitation({
      token: revoking.token,
      user: { id: invitee.id, email: `revoked-${STAMP}@example.test` },
    }),
  )
  check('revoked invitation refused', revokedMsg !== null, revokedMsg ?? 'IT WAS ACCEPTED')
  check(
    'expired and revoked say DIFFERENT things',
    expiredMsg !== revokedMsg,
  )

  // --- 5. The last owner -----------------------------------------------------

  const demote = await refusal(() =>
    invitations.changeWorkspaceMemberRole({
      payload,
      workspaceId: workspace.id,
      userId: inviter.id,
      role: 'admin',
      actorId: inviter.id,
    }),
  )
  check('last owner cannot be demoted', demote !== null, demote ?? 'IT WAS DEMOTED')

  const remove = await refusal(() =>
    invitations.removeWorkspaceMember({ payload, workspaceId: workspace.id, userId: inviter.id, actorId: inviter.id }),
  )
  check('last owner cannot be removed', remove !== null, remove ?? 'IT WAS REMOVED')

  // With a second owner the guard releases, which is what makes it a guard
  // rather than a wall.
  await invitations.changeWorkspaceMemberRole({
    payload,
    workspaceId: workspace.id,
    userId: invitee.id,
    role: 'owner',
    actorId: inviter.id,
  })
  const nowDemotable = await refusal(() =>
    invitations.changeWorkspaceMemberRole({
      payload,
      workspaceId: workspace.id,
      userId: inviter.id,
      role: 'admin',
      actorId: inviter.id,
    }),
  )
  check('with two owners the first can be demoted', nowDemotable === null, nowDemotable ?? '')

  // --- 6. Removal takes both writes back ------------------------------------

  await invitations.removeWorkspaceMember({ payload, workspaceId: workspace.id, userId: inviter.id, actorId: inviter.id })
  const afterRemove = await payload.findByID({
    collection: 'workspaces',
    id: workspace.id,
    depth: 0,
    overrideAccess: true,
  })
  const legacyAfter = (afterRemove.members ?? []).map((m) => (typeof m === 'number' ? m : m.id))
  const rowAfter = await payload.count({
    collection: 'workspace-members',
    where: { and: [{ workspace: { equals: workspace.id } }, { user: { equals: inviter.id } }] },
    overrideAccess: true,
  })
  check('removal deleted the workspace-members row', rowAfter.totalDocs === 0)
  check('removal took the legacy entry too', !legacyAfter.includes(inviter.id), `[${legacyAfter.join(', ')}]`)

  // --- 7. The audit trail ----------------------------------------------------

  const audit = await payload.find({
    collection: 'activity',
    where: {
      and: [{ entityType: { equals: 'workspace' } }, { entityId: { equals: String(workspace.id) } }],
    },
    limit: 100,
    depth: 0,
    sort: 'createdAt',
    overrideAccess: true,
  })
  const verbs = audit.docs.map((row) => row.action)
  console.log(`audit rows: ${verbs.join(', ') || '(none)'}`)
  for (const verb of ['invite_sent', 'invite_accepted', 'invite_revoked', 'role_changed', 'member_removed']) {
    check(`audit row written for ${verb}`, verbs.includes(verb))
  }

  // The audit view scopes by workspace id, so a row from ANOTHER workspace must
  // not be reachable through this scope.
  check(
    'every audit row is scoped to this workspace',
    audit.docs.every((row) => row.entityId === String(workspace.id)),
  )
} catch (err) {
  // Printed rather than swallowed: the `finally` below always runs and always
  // exits, so without this a fixture failure looks like a script that did
  // nothing.
  failures += 1
  console.log('FAIL  the script itself threw —', err instanceof Error ? err.stack || err.message : String(err))
} finally {
  // --- Cleanup ---------------------------------------------------------------
  const pool = getBrokerPool()
  if (created.channel != null) {
    await pool.query(`DELETE FROM team_members WHERE team_id = $1`, [created.channel])
    await pool.query(`DELETE FROM teams WHERE id = $1`, [created.channel])
  }
  if (created.workspace != null) {
    await payload.delete({
      collection: 'activity',
      where: {
        and: [{ entityType: { equals: 'workspace' } }, { entityId: { equals: String(created.workspace) } }],
      },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'invitations',
      where: { workspace: { equals: created.workspace } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'workspace-members',
      where: { workspace: { equals: created.workspace } },
      overrideAccess: true,
    })
    await payload.delete({ collection: 'workspaces', id: created.workspace, overrideAccess: true })
  }
  for (const id of created.users) {
    await payload.delete({ collection: 'users', id, overrideAccess: true }).catch(() => {})
  }
  console.log(`cleaned up: workspace ${created.workspace}, channel ${created.channel}, users ${created.users.join(', ')}`)
  console.log(`\n${passes} passed, ${failures} failed`)
  await closeBrokerPool()
  process.exit(failures === 0 ? 0 : 1)
}
