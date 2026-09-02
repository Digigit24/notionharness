import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { isAllowedCollection, PAYLOAD_DATASOURCE_COLLECTIONS, type PayloadPropertyDef } from '../_lib'

/** Returns the allowlisted property schema plus every doc in a workspace,
 * projected down to just the fields the schema maps (`overrideAccess: true`,
 * `depth: 0`, same house pattern as every other server route in this app —
 * see `AGENTS.md`/session house rules on never leaking nested relation data). */
export async function GET(req: Request, { params }: { params: Promise<{ collection: string }> }) {
  const { collection } = await params
  if (!isAllowedCollection(collection)) {
    return NextResponse.json({ error: `Collection "${collection}" is not exposed as a database source.` }, { status: 404 })
  }
  const schema = PAYLOAD_DATASOURCE_COLLECTIONS[collection]
  const { searchParams } = new URL(req.url)
  const workspaceId = Number(searchParams.get('workspaceId'))
  if (!Number.isFinite(workspaceId)) {
    return NextResponse.json({ error: 'workspaceId is required.' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: collection as 'pages',
    where: { workspace: { equals: workspaceId } },
    limit: 1000,
    depth: 0,
    overrideAccess: true,
  })

  return NextResponse.json({
    properties: schema.properties,
    docs: result.docs.map((doc) => {
      const docRecord = doc as unknown as Record<string, unknown>
      return { id: doc.id, fields: Object.fromEntries(schema.properties.map((p: PayloadPropertyDef) => [p.id, docRecord[p.id]])) }
    }),
  })
}

/** Creates a new doc using the collection's `defaultCreateData`. */
export async function POST(req: Request, { params }: { params: Promise<{ collection: string }> }) {
  const { collection } = await params
  if (!isAllowedCollection(collection)) {
    return NextResponse.json({ error: `Collection "${collection}" is not exposed as a database source.` }, { status: 404 })
  }
  const schema = PAYLOAD_DATASOURCE_COLLECTIONS[collection]
  const body = await req.json().catch(() => null)
  const workspaceId = Number(body?.workspaceId)
  if (!Number.isFinite(workspaceId)) {
    return NextResponse.json({ error: 'workspaceId is required.' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const user = await getCurrentPayloadUser()
  let data: Record<string, unknown>
  try {
    data = await schema.defaultCreateData({ workspaceId, payload, userId: user?.id ?? null })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to create row.' }, { status: 400 })
  }
  const doc = await payload.create({
    collection: collection as 'pages',
    data: data as never,
    overrideAccess: true,
  })

  const docRecord = doc as unknown as Record<string, unknown>
  return NextResponse.json({
    doc: { id: doc.id, fields: Object.fromEntries(schema.properties.map((p: PayloadPropertyDef) => [p.id, docRecord[p.id]])) },
  })
}
