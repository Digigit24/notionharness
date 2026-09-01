// ROADMAP 6.1 smoke test. Uses disposable in-memory Payload-shaped fixtures;
// no database connection or live page is needed. Run with:
//   npm run test:agent-page-writes
import { appendBlockToSubtree, createRunSubtree } from '../lib/agent-page-writes'
import { applyDocSync, encodeDocUpdate, getNote, loadDoc } from '../lib/blocksuite-doc'
import { Text } from '../lib/blocksuite-store'
import type { Payload } from 'payload'

type FixturePage = { id: number; docState: { update: string } }

function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${label}`)
  console.log(`OK  ${label}`)
}

function texts(block: unknown): string[] {
  if (!block || typeof block !== 'object') return []
  const model = block as { text?: { toString(): string }; children?: unknown[] }
  return [...(model.text ? [model.text.toString()] : []), ...(model.children ?? []).flatMap(texts)]
}

function fixturePayload(page: FixturePage): Payload {
  return {
    findByID: async () => page,
    update: async ({ data }: { data: { docState?: { update: string } } }) => {
      if (data.docState) page.docState = data.docState
      return page
    },
  } as unknown as Payload
}

async function main(): Promise<void> {
  const seed = loadDoc(1, 'Disposable page', null)
  const page: FixturePage = { id: 1, docState: { update: encodeDocUpdate(seed.doc) } }
  const payload = fixturePayload(page)

  const subtree = await createRunSubtree(payload, page.id, 'Agent run #test')
  const afterCreate = loadDoc(page.id, 'Disposable page', page.docState).doc
  const note = getNote(afterCreate)
  const handle = afterCreate.getBlock(subtree)
  check('createRunSubtree creates a toggle block under the page note', Boolean(note && handle && note.children.includes(handle)))

  const firstChild = await appendBlockToSubtree(payload, page.id, subtree, { kind: 'heading', level: 2, text: 'Agent heading' })
  const secondChild = await appendBlockToSubtree(payload, page.id, subtree, { kind: 'paragraph', text: 'Agent finding' })
  const afterAppend = loadDoc(page.id, 'Disposable page', page.docState).doc
  const persistedHandle = afterAppend.getBlock(subtree)
  check('appendBlockToSubtree returns two child ids', Boolean(firstChild && secondChild && firstChild !== secondChild))
  check('appendBlockToSubtree writes children under its handle', Boolean(persistedHandle && persistedHandle.children.some((child) => child.id === firstChild) && persistedHandle.children.some((child) => child.id === secondChild)))
  check('subtree content contains expected fixture text', texts(persistedHandle).includes('Agent heading') && texts(persistedHandle).includes('Agent finding'))

  await appendBlockToSubtree(payload, page.id, subtree, { kind: 'paragraph', text: 'Human branch edit' })
  const base = page.docState.update
  const agentFork = loadDoc(page.id, 'Disposable page', { update: base }).doc
  const humanFork = loadDoc(page.id, 'Disposable page', { update: base }).doc
  check('forks share the existing run subtree', Boolean(agentFork.getBlock(subtree) && humanFork.getBlock(subtree)))
  agentFork.addBlock('affine:paragraph', { type: 'text', text: new Text('Agent fork edit') }, subtree)
  const agentUpdate = encodeDocUpdate(agentFork)
  humanFork.addBlock('affine:paragraph', { type: 'text', text: new Text('Human fork edit') }, subtree)
  const humanUpdate = encodeDocUpdate(humanFork)
  await applyDocSync(payload, page.id, agentUpdate)
  await applyDocSync(payload, page.id, humanUpdate)
  const merged = loadDoc(page.id, 'Disposable page', page.docState).doc
  const mergedHandle = merged.getBlock(subtree)
  check('independent agent and human CRDT writes both survive sync', Boolean(mergedHandle && mergedHandle.children.length >= 5 && texts(mergedHandle).includes('Agent fork edit') && texts(mergedHandle).includes('Human fork edit')))

  check('appendBlockToSubtree has no external parent-id argument', appendBlockToSubtree.length === 4)
  check('appendBlockToSubtree exposes no unrestricted update/delete operation', !appendBlockToSubtree.toString().includes('updateBlock') && !appendBlockToSubtree.toString().includes('deleteBlock'))
  await appendBlockToSubtree(payload, page.id, 'missing-subtree', { kind: 'paragraph', text: 'must fail' }).then(
    () => { throw new Error('FAIL: invalid subtree handle unexpectedly succeeded') },
    (error: unknown) => check('missing subtree handle fails cleanly', error instanceof Error && error.message.includes('no longer exists')),
  )

  console.log('\nALL CHECKS PASSED')
}

main().catch((error: unknown) => {
  console.error('[agent-page-writes smoke] FAILED:', error)
  process.exitCode = 1
})
