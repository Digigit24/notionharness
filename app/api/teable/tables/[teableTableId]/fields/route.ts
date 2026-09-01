import { NextResponse } from 'next/server'
import { parseBody, resolveTable, teableFetch, upstreamResponse } from '../../../_lib'

async function getId(params: Promise<{ teableTableId: string }>) {
  const { teableTableId } = await params
  return { teableTableId, resolved: await resolveTable(teableTableId) }
}
export async function GET(_req: Request, { params }: { params: Promise<{ teableTableId: string }> }) {
  const { teableTableId, resolved } = await getId(params)
  if (!resolved) return NextResponse.json({ error: 'Teable table connection not found.' }, { status: 404 })
  const result = await teableFetch(`/table/${encodeURIComponent(teableTableId)}/field`)
  return result.ok ? upstreamResponse(result.response) : result.response
}
export async function POST(req: Request, { params }: { params: Promise<{ teableTableId: string }> }) {
  const { teableTableId, resolved } = await getId(params)
  if (!resolved) return NextResponse.json({ error: 'Teable table connection not found.' }, { status: 404 })
  const body = await parseBody(req)
  if (body?.type === 'link') {
    const targetId = typeof body.targetDatabaseId === 'string' ? body.targetDatabaseId : typeof body.targetTableId === 'string' ? body.targetTableId : ''
    if (!targetId) return NextResponse.json({ error: 'Link fields require targetDatabaseId or targetTableId.' }, { status: 400 })
    const payload = await (await import('@/lib/payload')).getPayloadClient()
    const targetResult = await payload.find({ collection: 'teable-databases', where: { or: [{ id: { equals: Number.isFinite(Number(targetId)) ? Number(targetId) : targetId } }, { teableTableId: { equals: targetId } }] }, limit: 1, overrideAccess: true })
    const target = targetResult.docs[0] as unknown as { teableTableId?: string; workspace?: number; teableBaseId?: string } | undefined
    const sourceWorkspace = typeof resolved.doc.workspace === 'object' && resolved.doc.workspace ? (resolved.doc.workspace as { id?: number }).id : resolved.doc.workspace
    const targetWorkspace = typeof target?.workspace === 'object' && target.workspace ? (target.workspace as unknown as { id?: number }).id : target?.workspace
    if (!target || targetWorkspace !== sourceWorkspace) return NextResponse.json({ error: 'Relation target must be in the same workspace.' }, { status: 400 })
    const tablesResult = await teableFetch(`/base/${encodeURIComponent(resolved.baseId || '')}/table`)
    if (!tablesResult.ok) return tablesResult.response
    const tables = await tablesResult.response.json() as Array<{ id: string; dbTableName?: string }>
    const foreignTableId = target.teableTableId
    const foreignTable = tables.find((table) => table.id === foreignTableId)
    if (!foreignTable) return NextResponse.json({ error: 'Relation target table not found.' }, { status: 404 })
    const fieldsResult = await teableFetch(`/table/${encodeURIComponent(foreignTableId || '')}/field`)
    if (!fieldsResult.ok) return fieldsResult.response
    const foreignFields = await fieldsResult.response.json() as Array<{ id: string; isPrimary?: boolean; dbFieldName?: string }>
    const primary = foreignFields.find((field) => field.isPrimary) || foreignFields[0]
    if (!primary) return NextResponse.json({ error: 'Relation target has no fields.' }, { status: 400 })
    const sourceTablesResult = tables.find((table) => table.id === teableTableId)
    const options = { relationship: body.relationship || 'manyOne', foreignTableId, lookupFieldId: primary.id, fkHostTableName: sourceTablesResult?.dbTableName || teableTableId, selfKeyName: `${teableTableId}_id`, foreignKeyName: `${foreignTableId}_id` }
    const result = await teableFetch(`/table/${encodeURIComponent(teableTableId)}/field`, { method: 'POST', body: JSON.stringify({ ...body, targetDatabaseId: undefined, targetTableId: undefined, options }) })
    return result.ok ? upstreamResponse(result.response) : result.response
  }
  const result = await teableFetch(`/table/${encodeURIComponent(teableTableId)}/field`, { method: 'POST', body: JSON.stringify(body) })
  return result.ok ? upstreamResponse(result.response) : result.response
}
