import { NextResponse } from 'next/server'
import { getBuildId } from '@/lib/build-id'

// The build id is not a secret — it is already the prefix of every
// `/_next/static/<buildId>/…` URL a page loads — so this answers without a
// session, which also lets a tab whose session has expired still discover
// that it needs a reload.
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({ buildId: getBuildId() }, { headers: { 'Cache-Control': 'no-store' } })
}
