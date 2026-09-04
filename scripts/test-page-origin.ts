// Does a page say where it came from?
//
// This guards a bug that shipped silently: `getPageOrigin` compared
// `linkedSourceType` against 'user-database' while the collection stores
// 'userDatabase', so the record header claimed in R7.4 never rendered for any
// of the real row-paired pages in this database. A typecheck cannot catch a
// mismatch between a stored enum value and a retyped literal — only running it
// against real rows can.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const { getPageOrigin } = await import('../lib/page-origin')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const payload = await getPayloadClient()

// --- Real row-paired pages already in this database ---
const rowPages = await payload.find({
  collection: 'pages',
  where: { linkedSourceType: { equals: 'userDatabase' } },
  depth: 0,
  limit: 5,
  overrideAccess: true,
})
console.log(`row-paired pages found: ${rowPages.docs.length}`)
if (rowPages.docs.length === 0) {
  console.log('SKIP  no row-paired pages exist to check')
} else {
  let resolved = 0
  for (const page of rowPages.docs) {
    const origin = await getPageOrigin(payload, page)
    if (origin?.kind === 'record') {
      resolved += 1
      console.log(`  page ${page.id}: "${origin.title}" in ${origin.databaseName}`)
      check(`  page ${page.id} resolves a real row title, not an id`, !/^Record\s/i.test(origin.title), origin.title)
    } else {
      console.log(`  page ${page.id}: origin = ${origin?.kind ?? 'null'}`)
    }
  }
  check('every row-paired page resolves a record origin', resolved === rowPages.docs.length, `${resolved}/${rowPages.docs.length}`)
}

// --- A channel canvas, created and torn down ---
const teams = await import('../lib/broker/teams')
const { closeBrokerPool } = await import('../lib/broker/db')
const workspace = (await payload.find({ collection: 'workspaces', limit: 1, depth: 0, overrideAccess: true })).docs[0]
if (!workspace) throw new Error('No workspace.')

let teamId: number | null = null
let pageId: number | null = null
try {
  const team = await teams.createTeam({ workspaceId: workspace.id, name: `origin-probe-${Date.now() % 100000}` })
  teamId = team.id
  // The write the canvas pane will make. If the enum lacked 'team' this throws.
  const canvas = await payload.create({
    collection: 'pages',
    data: {
      title: `#${team.name}`,
      workspace: workspace.id,
      linkedSourceType: 'team',
      linkedSourceId: String(team.id),
    },
    overrideAccess: true,
  })
  pageId = canvas.id
  check('a page can be tagged as a channel canvas', true)

  const origin = await getPageOrigin(payload, canvas)
  check('a canvas resolves a channel origin', origin?.kind === 'channel', String(origin?.kind))
  check(
    'and names its channel',
    origin?.kind === 'channel' && origin.channelName === team.name,
    origin?.kind === 'channel' ? origin.channelName : '',
  )

  // The whole reason for tagging it: it must stay out of the sidebar tree.
  const { getSidebarPages } = await import('../lib/pages-cache')
  const sidebar = await getSidebarPages(workspace.id)
  check(
    'and stays out of the sidebar tree',
    !sidebar.some((p) => p.id === canvas.id),
    `${sidebar.length} sidebar pages`,
  )
} finally {
  if (pageId != null) await payload.delete({ collection: 'pages', id: pageId, overrideAccess: true }).catch(() => undefined)
  if (teamId != null) await teams.deleteTeam(teamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
