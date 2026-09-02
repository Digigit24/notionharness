import { NextResponse } from 'next/server'
import { appendBlockToSubtree, createRunSubtree, type AgentBlockSpec } from '@/lib/agent-page-writes'
import { ensureTaskPage } from '@/lib/task-pages'
import { getPayloadClient } from '@/lib/payload'
import { appendRunEvent } from '@/lib/broker/messages'
import { getRun, getRunPageContext, setRunPageContext } from '@/lib/broker/runs'

const BLOCK_KINDS = new Set(['heading', 'paragraph', 'list', 'code'])

function isBlockSpec(value: unknown): value is AgentBlockSpec {
  if (!value || typeof value !== 'object') return false
  const spec = value as Record<string, unknown>
  if (!BLOCK_KINDS.has(spec.kind as string) || typeof spec.text !== 'string' || spec.text.length > 100_000) return false
  if (spec.kind === 'heading') return spec.level === 1 || spec.level === 2 || spec.level === 3
  if (spec.kind === 'list') {
    if (spec.type !== 'bulleted' && spec.type !== 'numbered' && spec.type !== 'todo') return false
    return spec.checked === undefined || typeof spec.checked === 'boolean'
  }
  if (spec.kind === 'code') return spec.language === undefined || spec.language === null || typeof spec.language === 'string'
  return true
}

/** Daemon command bridge: Payload/Yjs writes stay inside the Next process. */
export async function POST(request: Request) {
  const authorization = request.headers.get('authorization')
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!token) return NextResponse.json({ error: 'Missing bearer token.' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 }) }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  const input = body as Record<string, unknown>
  const runId = Number(input.runId)
  const taskId = Number(input.taskId)
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(taskId) || !isBlockSpec(input.spec)) {
    return NextResponse.json({ error: 'runId, taskId and a valid spec are required.' }, { status: 400 })
  }

  const run = await getRun(runId)
  if (!run || run.taskId !== taskId) return NextResponse.json({ error: 'Run/task not found.' }, { status: 404 })
  if (!run.runToken || token !== run.runToken) return NextResponse.json({ error: 'Invalid run token.' }, { status: 401 })
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return NextResponse.json({ error: 'Run is settled.' }, { status: 409 })

  const payload = await getPayloadClient()
  let context = await getRunPageContext(runId)
  if (!context) {
    const pageId = await ensureTaskPage(payload, taskId)
    const subtreeBlockId = await createRunSubtree(payload, pageId, `Agent run #${runId}`)
    await setRunPageContext(runId, pageId, subtreeBlockId)
    context = { pageId, subtreeBlockId }
  }

  const blockId = await appendBlockToSubtree(payload, context.pageId, context.subtreeBlockId, input.spec)
  await appendRunEvent(runId, {
    type: 'page_write',
    pageId: context.pageId,
    subtree: context.subtreeBlockId,
    blockId,
    operation: 'append',
    kind: input.spec.kind,
    status: 'committed',
  })
  return NextResponse.json({ blockId, pageId: context.pageId, subtree: context.subtreeBlockId })
}
