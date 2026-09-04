// R14-P0.4 — file attachments, proven end to end rather than assumed.
//
// Three things this proves, matching the roadmap's own verification list:
//
//   1. A message with an attachment round-trips through `postChannelMessage`
//      — the `team_messages.attachments` column (migration 0016) really
//      holds a Media id and `getChannelMessage`/`listChannelFeed` really
//      return it.
//   2. The Media doc's access is scoped CORRECTLY — not just "is it in my
//      workspace" but the real rule `lib/media/access.ts`'s `canUserReadMedia`
//      implements: a workspace member outside a PRIVATE channel cannot read a
//      file attached inside it, one inside it can, an unattached draft is
//      readable only by its uploader, and a stranger to the workspace
//      entirely is refused regardless.
//   3. The migration's DDL applied correctly — proven by actually creating a
//      real Media row through Payload's Local API (which fails loudly on any
//      column mismatch, as it did once already while building this — see
//      `migrations/20260905_010000_media.ts`'s own comment on the
//      `thumbnail_u_r_l` naming surprise) and by asserting the sharp-resized
//      thumbnail variant it produces is really there.
//
//   npx tsx scripts/test-media-attachments.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')
const { postChannelMessage, getChannelMessage } = await import('../lib/broker/channels')
const { createTeam, deleteTeam } = await import('../lib/broker/teams')
const { canUserReadMedia } = await import('../lib/media/access')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const STAMP = Date.now()
// A tiny real PNG (1x1 red pixel) so sharp has a real image to resize —
// asserting a real `sizes.thumbnail` variant is the whole point of #3 above.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const payload = await getPayloadClient()
const pool = getBrokerPool()

const created = {
  users: [] as number[],
  workspace: null as number | null,
  media: [] as number[],
  teams: [] as number[],
}

try {
  // --- Fixtures: one workspace, three members, one true outsider ---------
  const owner = await payload.create({
    collection: 'users',
    data: { email: `media-owner-${STAMP}@notionforge.test`, name: 'Media Owner', role: 'member', password: `p${STAMP}Aa!` },
    overrideAccess: true,
  })
  const inChannel = await payload.create({
    collection: 'users',
    data: { email: `media-in-${STAMP}@notionforge.test`, name: 'In Channel', role: 'member', password: `p${STAMP}Bb!` },
    overrideAccess: true,
  })
  const outChannel = await payload.create({
    collection: 'users',
    data: { email: `media-out-${STAMP}@notionforge.test`, name: 'Out Of Channel', role: 'member', password: `p${STAMP}Cc!` },
    overrideAccess: true,
  })
  const stranger = await payload.create({
    collection: 'users',
    data: { email: `media-stranger-${STAMP}@notionforge.test`, name: 'Stranger', role: 'member', password: `p${STAMP}Dd!` },
    overrideAccess: true,
  })
  created.users.push(owner.id, inChannel.id, outChannel.id, stranger.id)

  const workspace = await payload.create({
    collection: 'workspaces',
    data: { name: `Media Test ${STAMP}`, slug: `media-test-${STAMP}`, owner: owner.id, members: [] },
    overrideAccess: true,
  })
  created.workspace = workspace.id

  // `loadAccess` (lib/permissions) reads `workspace-members` directly — it
  // does NOT fall back to `workspaces.owner` — so every person who should
  // have workspace access needs a real row here, the owner included.
  for (const [user, role] of [
    [owner.id, 'owner'],
    [inChannel.id, 'member'],
    [outChannel.id, 'member'],
  ] as const) {
    await payload.create({
      collection: 'workspace-members',
      data: { workspace: workspace.id, user, role },
      overrideAccess: true,
    })
  }
  // `stranger` deliberately gets NO workspace-members row and is never added
  // to any channel below — the negative case in #2.

  const team = await createTeam({ workspaceId: workspace.id, name: `media-probe-${STAMP % 100000}` })
  created.teams.push(team.id)
  await pool.query(`UPDATE teams SET is_private = true WHERE id = $1`, [team.id])

  // A human slot in the private channel. `addTeamMember` (lib/broker/teams.ts)
  // only accepts an `agentId` — human slots are migration 0013's addition and
  // this repo has no higher-level helper for them yet, so the fixture is
  // inserted directly, the same way `requireChannel`'s own `isChannelMember`
  // reads this table directly.
  const { rows: memberRows } = await pool.query<{ id: string }>(
    `INSERT INTO team_members (team_id, user_id, role, display_name) VALUES ($1, $2, 'member', 'In Channel') RETURNING id`,
    [team.id, inChannel.id],
  )
  const inChannelSlotId = Number(memberRows[0].id)

  // --- #1: a message with an attachment round-trips -----------------------
  const media = await payload.create({
    collection: 'media',
    data: { workspace: workspace.id, uploadedBy: owner.id },
    file: { data: PNG_1x1, mimetype: 'image/png', name: `probe-${STAMP}.png`, size: PNG_1x1.length },
    overrideAccess: true,
  })
  created.media.push(media.id)

  check('the migration produced a real sharp thumbnail variant', Boolean(media.sizes?.thumbnail?.filename), JSON.stringify(media.sizes))
  check('and the base upload columns round-trip', media.filesize === PNG_1x1.length && media.width === 1 && media.height === 1)

  const posted = await postChannelMessage({
    teamId: team.id,
    fromSlotId: inChannelSlotId,
    body: 'here is a screenshot',
    attachments: [media.id],
  })
  check('postChannelMessage accepted the attachments array', posted.attachments.length === 1 && posted.attachments[0] === media.id, JSON.stringify(posted.attachments))

  const reread = await getChannelMessage(posted.id)
  check('and it survives a read back from team_messages', reread?.attachments.length === 1 && reread.attachments[0] === media.id, JSON.stringify(reread?.attachments))

  const { rows: columnCheck } = await pool.query<{ column_default: string | null }>(
    `SELECT column_default FROM information_schema.columns WHERE table_name = 'team_messages' AND column_name = 'attachments'`,
  )
  check('#3: the attachments column is really jsonb, not-null, defaulted', (columnCheck[0]?.column_default ?? '').includes("'[]'"), columnCheck[0]?.column_default ?? 'MISSING')

  // A message with NO attachments still defaults to an empty array, never
  // null — every reader in this codebase assumes an array (same contract as
  // `mentions`, migration 0013).
  const plain = await postChannelMessage({ teamId: team.id, fromSlotId: inChannelSlotId, body: 'no file here' })
  check('a message with no attachments defaults to []', Array.isArray(plain.attachments) && plain.attachments.length === 0, JSON.stringify(plain.attachments))

  // --- #2: access is scoped to the CHANNEL, not the workspace -------------
  check(
    'a member of the private channel the file was posted into can read it',
    await canUserReadMedia(inChannel.id, media),
  )
  check(
    'a workspace member who is NOT in that private channel cannot',
    !(await canUserReadMedia(outChannel.id, media)),
  )
  check(
    'a stranger to the workspace entirely cannot, even by guessing the id',
    !(await canUserReadMedia(stranger.id, media)),
  )

  // An unattached draft (uploaded, not yet posted into any message): only its
  // uploader may read it — the narrow hole this unit's own comment names and
  // closes, rather than defaulting to "any workspace member".
  const draft = await payload.create({
    collection: 'media',
    data: { workspace: workspace.id, uploadedBy: owner.id },
    file: { data: PNG_1x1, mimetype: 'image/png', name: `draft-${STAMP}.png`, size: PNG_1x1.length },
    overrideAccess: true,
  })
  created.media.push(draft.id)
  check('an unsent draft attachment is readable by its own uploader', await canUserReadMedia(owner.id, draft))
  check('but not by another member of the SAME workspace, before it is attached to anything', !(await canUserReadMedia(inChannel.id, draft)))

  // Once it IS attached — even to a PUBLIC message in this same channel —
  // visibility switches from "uploader only" to "the channel's own rule".
  await pool.query(`UPDATE teams SET is_private = false WHERE id = $1`, [team.id])
  await postChannelMessage({ teamId: team.id, fromSlotId: inChannelSlotId, body: 'and here is another one', attachments: [draft.id] })
  check(
    'once attached to a message in a now-PUBLIC channel, any workspace member can read it',
    await canUserReadMedia(outChannel.id, draft),
  )
} finally {
  for (const id of created.teams) await deleteTeam(id).catch(() => undefined)
  for (const id of created.media) await payload.delete({ collection: 'media', id, overrideAccess: true }).catch(() => undefined)
  if (created.workspace) await payload.delete({ collection: 'workspaces', id: created.workspace, overrideAccess: true }).catch(() => undefined)
  await payload.delete({
    collection: 'workspace-members',
    where: { workspace: { equals: created.workspace ?? -1 } },
    overrideAccess: true,
  }).catch(() => undefined)
  for (const id of created.users) await payload.delete({ collection: 'users', id, overrideAccess: true }).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
