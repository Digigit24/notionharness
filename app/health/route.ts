import { NextResponse } from 'next/server'

/**
 * Diagnostic for the recurring "dev server dies with no crash signature"
 * investigation. Every recent crash's log ended immediately after a
 * `GET /health 404` — no route previously existed at this exact path. This
 * exists purely to test whether an external probe reacting to that 404 was
 * the actual trigger; if crashes still recur after this lands, that theory
 * is ruled out and the probe itself (not its response code) is implicated.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' })
}
