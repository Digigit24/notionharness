// A page cover's Media doc must be readable by any workspace member — not
// just its uploader — the moment a real `pages` row references it as
// `coverImage: 'media:<id>'`. Before this fix, `canUserReadMedia` only knew
// about channel attachments; a page-cover image fell into its "unattached"
// branch and stayed uploader-only forever, so anyone else viewing the page
// would get a broken image.
//
// Three things proved against real rows:
//   1. A plain workspace member (not the uploader, in no channel) CAN read
//      a media doc once a page references it as `media:<id>`.
//   2. A stranger to the workspace still CANNOT — the workspace floor
//      `isWorkspaceMember` establishes is unaffected by the new branch.
//   3. The PRE-EXISTING unattached-draft behaviour is unchanged: before any
//      page references the upload, only the uploader may read it.
//
//   npx tsx scripts/test-page-cover-media-access.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const { canUserReadMedia } = await import('../lib/media/access')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const STAMP = Date.now()
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const payload = await getPayloadClient()
const created = { users: [] as number[], workspace: null as number | null, media: [] as number[], pages: [] as number[] }

try {
  const owner = await payload.create({
    collection: 'users',
    data: { email: `cover-owner-${STAMP}@notionforge.test`, name: 'Cover Owner', role: 'member', password: `p${STAMP}Aa!` },
    overrideAccess: true,
  })
  const otherMember = await payload.create({
    collection: 'users',
    data: { email: `cover-member-${STAMP}@notionforge.test`, name: 'Other Member', role: 'member', password: `p${STAMP}Bb!` },
    overrideAccess: true,
  })
  const stranger = await payload.create({
    collection: 'users',
    data: { email: `cover-stranger-${STAMP}@notionforge.test`, name: 'Stranger', role: 'member', password: `p${STAMP}Cc!` },
    overrideAccess: true,
  })
  created.users.push(owner.id, otherMember.id, stranger.id)

  const workspace = await payload.create({
    collection: 'workspaces',
    data: { name: `Cover Test ${STAMP}`, slug: `cover-test-${STAMP}`, owner: owner.id, members: [] },
    overrideAccess: true,
  })
  created.workspace = workspace.id

  for (const [user, role] of [[owner.id, 'owner'], [otherMember.id, 'member']] as const) {
    await payload.create({
      collection: 'workspace-members',
      data: { workspace: workspace.id, user, role },
      overrideAccess: true,
    })
  }
  // `stranger` deliberately gets no workspace-members row — the negative case.

  const media = await payload.create({
    collection: 'media',
    data: { workspace: workspace.id, uploadedBy: owner.id },
    file: { data: PNG_1x1, mimetype: 'image/png', name: `cover-${STAMP}.png`, size: PNG_1x1.length },
    overrideAccess: true,
  })
  created.media.push(media.id)

  // --- #3: before any page references it, unattached-draft rules apply ---
  check(
    'before it is a cover, only the uploader can read a fresh upload',
    (await canUserReadMedia(owner.id, media)) === true && (await canUserReadMedia(otherMember.id, media)) === false,
  )

  const page = await payload.create({
    collection: 'pages',
    data: { title: `Cover page ${STAMP}`, workspace: workspace.id, coverImage: `media:${media.id}` },
    overrideAccess: true,
  })
  created.pages.push(page.id)

  // --- #1: any workspace member can read it once it's a real page cover --
  check('a workspace member who did NOT upload it can read it once it is a page cover', await canUserReadMedia(otherMember.id, media))
  check('the uploader can still read their own upload', await canUserReadMedia(owner.id, media))

  // --- #2: the workspace floor still holds ---------------------------------
  check('a stranger to the workspace cannot read it, even as a page cover', !(await canUserReadMedia(stranger.id, media)))
} finally {
  for (const id of created.pages) await payload.delete({ collection: 'pages', id, overrideAccess: true }).catch(() => undefined)
  for (const id of created.media) await payload.delete({ collection: 'media', id, overrideAccess: true }).catch(() => undefined)
  if (created.workspace != null) {
    await payload
      .delete({ collection: 'workspace-members', where: { workspace: { equals: created.workspace } }, overrideAccess: true })
      .catch(() => undefined)
    await payload.delete({ collection: 'workspaces', id: created.workspace, overrideAccess: true }).catch(() => undefined)
  }
  for (const id of created.users) await payload.delete({ collection: 'users', id, overrideAccess: true }).catch(() => undefined)
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
