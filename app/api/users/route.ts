import { NextResponse } from 'next/server'
import { authPool } from '@/lib/auth'
import { getSession } from '@/lib/session'

/**
 * Lists real Better Auth accounts for the editor's @mention popup. Requires
 * an active session (this is otherwise unauthenticated data) and only ever
 * returns id/name/email/image — never session tokens or other auth internals.
 */
export async function GET(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ users: [] }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim()

  const result = q
    ? await authPool.query(
        `SELECT id, name, email, image FROM "user" WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 20`,
        [`%${q}%`],
      )
    : await authPool.query(`SELECT id, name, email, image FROM "user" ORDER BY name LIMIT 20`)

  return NextResponse.json({ users: result.rows })
}
