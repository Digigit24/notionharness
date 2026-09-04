// R7.4 (A3.5) verification — per-block accept and reject.
//
// The point being checked is that a decision on ONE block leaves the others
// alone. Whole-run accept/reject already existed; the failure mode worth
// guarding is a per-block action that quietly takes the whole proposal with it.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const { createRunSubtree, appendBlockToSubtree } = await import('../lib/agent-page-writes')
const { listProposedBlocks, acceptProposedBlock, rejectProposedBlock } = await import('../lib/agent-suggestions')
const { setRunPageContext } = await import('../lib/broker/runs')
const { closeBrokerPool, getBrokerPool } = await import('../lib/broker/db')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const payload = await getPayloadClient()
const workspace = (await payload.find({ collection: 'workspaces', limit: 1, depth: 0, overrideAccess: true })).docs[0]
if (!workspace) throw new Error('No workspace.')

let pageId: number | null = null
let runId: number | null = null
try {
  const page = await payload.create({
    collection: 'pages',
    data: { title: 'Proposal test', workspace: workspace.id },
    overrideAccess: true,
  })
  pageId = page.id

  const pool = getBrokerPool()
  const user = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
  const created = await pool.query<{ id: string }>(
    `INSERT INTO runs (status, accountable_user, page_id) VALUES ('running', $1, $2) RETURNING id`,
    [user.rows[0].id, pageId],
  )
  runId = Number(created.rows[0].id)

  const subtree = await createRunSubtree(payload, pageId, `Agent run #${runId}`)
  await setRunPageContext(runId, pageId, subtree)
  await appendBlockToSubtree(payload, pageId, subtree, { kind: 'paragraph', text: 'First proposal' })
  await appendBlockToSubtree(payload, pageId, subtree, { kind: 'paragraph', text: 'Second proposal' })
  await appendBlockToSubtree(payload, pageId, subtree, { kind: 'paragraph', text: 'Third proposal' })

  let proposed = await listProposedBlocks(payload, runId)
  check('all proposed blocks are listed', proposed.length === 3, `${proposed.length}`)
  check('with their text, for review without an editor', proposed[0]?.text === 'First proposal', proposed[0]?.text)

  // Reject the middle one. The others must survive.
  await rejectProposedBlock(payload, runId, proposed[1].id)
  proposed = await listProposedBlocks(payload, runId)
  check('rejecting one block removes exactly that block', proposed.length === 2, `${proposed.length} left`)
  check(
    'and leaves the others untouched',
    proposed.map((b) => b.text).join('|') === 'First proposal|Third proposal',
    proposed.map((b) => b.text).join('|'),
  )

  // Accept one. It should leave the proposal but stay on the page.
  await acceptProposedBlock(payload, runId, proposed[0].id)
  const afterAccept = await listProposedBlocks(payload, runId)
  check('accepting one block removes it from the proposal', afterAccept.length === 1, `${afterAccept.length} left`)
  check('and the remaining proposal is the untouched one', afterAccept[0]?.text === 'Third proposal', afterAccept[0]?.text)

  // The accepted block must still exist on the page, now outside the proposal.
  const { loadDoc, docToMarkdown } = await import('../lib/blocksuite-doc')
  const reread = await payload.findByID({ collection: 'pages', id: pageId, overrideAccess: true })
  const { doc } = loadDoc(pageId, reread.title || 'Untitled', reread.docState)
  // Markdown rather than a raw dump: it is the serialiser this app already
  // trusts, so it proves the block is really in the document rather than
  // merely present somewhere in an internal structure.
  const allText = await docToMarkdown(doc, reread.title || 'Untitled')
  check('the accepted block survives on the page', allText.includes('First proposal'))
  check('the rejected block is gone from the page', !allText.includes('Second proposal'))

  // Rejecting something already gone is success, not an error.
  let threw = false
  try {
    await rejectProposedBlock(payload, runId, 'does-not-exist')
  } catch {
    threw = true
  }
  check('rejecting an already-absent block is not an error', !threw)
} finally {
  if (runId != null) await getBrokerPool().query('DELETE FROM runs WHERE id = $1', [runId]).catch(() => undefined)
  if (pageId != null) await payload.delete({ collection: 'pages', id: pageId, overrideAccess: true }).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
