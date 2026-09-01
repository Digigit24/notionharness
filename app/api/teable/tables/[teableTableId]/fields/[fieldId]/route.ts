import { NextResponse } from 'next/server'
import { parseBody, resolveTable, teableFetch, upstreamResponse } from '../../../../_lib'
export async function PATCH(req: Request, { params }: { params: Promise<{ teableTableId: string; fieldId: string }> }) {
  const { teableTableId, fieldId } = await params; if (!await resolveTable(teableTableId)) return NextResponse.json({ error: 'Teable table connection not found.' }, { status: 404 })
  const result = await teableFetch(`/table/${encodeURIComponent(teableTableId)}/field/${encodeURIComponent(fieldId)}`, { method: 'PATCH', body: JSON.stringify(await parseBody(req)) }); return result.ok ? upstreamResponse(result.response) : result.response
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ teableTableId: string; fieldId: string }> }) {
  const { teableTableId, fieldId } = await params; if (!await resolveTable(teableTableId)) return NextResponse.json({ error: 'Teable table connection not found.' }, { status: 404 })
  const result = await teableFetch(`/table/${encodeURIComponent(teableTableId)}/field/${encodeURIComponent(fieldId)}`, { method: 'DELETE' }); return result.ok ? upstreamResponse(result.response) : result.response
}
