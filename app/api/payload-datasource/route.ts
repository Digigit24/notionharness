import { NextResponse } from 'next/server'
import { PAYLOAD_DATASOURCE_COLLECTIONS } from './_lib'

/** Lists which Payload collections are exposed as database-block sources (see `_lib.ts`'s allowlist). */
export async function GET() {
  return NextResponse.json({
    collections: Object.keys(PAYLOAD_DATASOURCE_COLLECTIONS).map((slug) => ({ slug })),
  })
}
