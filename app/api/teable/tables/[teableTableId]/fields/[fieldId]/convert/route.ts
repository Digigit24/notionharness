import { NextResponse } from 'next/server'
import { parseBody, resolveTable, teableFetch, upstreamResponse } from '../../../../../_lib'

// Teable requires the dedicated `/field/{fieldId}/convert` endpoint (PUT) to
// actually change a field's *type* — a plain `PATCH /field/{fieldId}` (see
// the sibling route) accepts a `type` in its body without error but silently
// leaves the field's real type unchanged (confirmed live against the running
// Teable instance: PATCH returned success, a follow-up GET showed the old
// type). `/convert` handles the real type cast + symmetric field handling.
export async function PUT(req: Request, { params }: { params: Promise<{ teableTableId: string; fieldId: string }> }) {
  const { teableTableId, fieldId } = await params
  if (!(await resolveTable(teableTableId))) return NextResponse.json({ error: 'Teable table connection not found.' }, { status: 404 })
  const result = await teableFetch(`/table/${encodeURIComponent(teableTableId)}/field/${encodeURIComponent(fieldId)}/convert`, {
    method: 'PUT',
    body: JSON.stringify(await parseBody(req)),
  })
  return result.ok ? upstreamResponse(result.response) : result.response
}
