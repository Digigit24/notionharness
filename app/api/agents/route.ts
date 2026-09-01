import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

/**
 * Lists enabled `agents` docs for a workspace, for the editor's `@mention`
 * popup's "Agents" group — mirrors `/api/user-databases`'s scoped-list shape.
 * Only ever returns id/name/model, never `customEnv`/`mcpConfig`/other
 * runtime-wiring internals.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const workspaceId = Number(searchParams.get('workspaceId'))
  if (!Number.isFinite(workspaceId)) {
    return NextResponse.json({ agents: [] })
  }
  const q = (searchParams.get('q') || '').trim()

  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'agents',
    where: {
      and: [
        { workspace: { equals: workspaceId } },
        { enabled: { equals: true } },
        ...(q ? [{ name: { like: q } }] : []),
      ],
    },
    limit: 20,
    depth: 0,
    overrideAccess: true,
  })

  return NextResponse.json({
    agents: result.docs.map((doc) => ({ id: doc.id, name: doc.name, model: doc.model ?? null })),
  })
}
