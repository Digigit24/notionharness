import { NextResponse } from 'next/server'
import { resolveTable, teableFetch } from '../../_lib'

export async function GET(_req: Request, { params }: { params: Promise<{ teableTableId: string }> }) {
  const { teableTableId } = await params
  const resolved = await resolveTable(teableTableId)
  if (!resolved) return NextResponse.json({ error: 'Teable table connection not found.' }, { status: 404 })
  // Teable's table metadata endpoint is exposed through the base table listing.
  const result = await teableFetch(`/base/${encodeURIComponent(resolved.baseId || '')}/table`)
  if (!result.ok) return result.response
  const tables = await result.response.json() as Array<{ id: string }>
  const table = tables.find((candidate) => candidate.id === teableTableId)
  return table ? NextResponse.json(table) : NextResponse.json({ error: 'Teable table not found.' }, { status: 404 })
}
