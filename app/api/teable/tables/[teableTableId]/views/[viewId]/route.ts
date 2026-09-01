import { NextResponse } from 'next/server'
import { resolveTable, teableFetch, upstreamResponse } from '../../../../_lib'

const resources = new Set(['filter', 'sort', 'group', 'options', 'name'])
async function update(req: Request, { params }: { params: Promise<{ teableTableId: string; viewId: string }> }) {
  const { teableTableId, viewId } = await params
  if (!await resolveTable(teableTableId)) return NextResponse.json({ error: 'Teable table connection not found.' }, { status: 404 })
  const body = await req.json().catch(() => null) as { resource?: string; value?: unknown; filter?: unknown; sort?: unknown; group?: unknown; options?: unknown; name?: unknown } | null
  const resource = body?.resource || Object.keys(body || {}).find((key) => resources.has(key))
  if (!resource || !resources.has(resource)) return NextResponse.json({ error: 'Invalid view resource.' }, { status: 400 })
  const value = body?.resource ? { [resource]: body.value } : { [resource]: body?.[resource as keyof typeof body] }
  const result = await teableFetch(`/table/${encodeURIComponent(teableTableId)}/view/${encodeURIComponent(viewId)}/${resource}`, { method: 'PUT', body: JSON.stringify(value) })
  return result.ok ? upstreamResponse(result.response) : result.response
}

export const PATCH = update
export const PUT = update
