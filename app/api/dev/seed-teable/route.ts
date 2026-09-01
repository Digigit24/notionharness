import { NextResponse } from 'next/server'
import { seedTeableDatabases } from '@/scripts/seed-teable-databases'

export async function POST(req: Request) {
  const suppliedKey = req.headers.get('x-dev-seed-key')
  const authorized = process.env.NODE_ENV !== 'production' || (suppliedKey && suppliedKey === process.env.PAYLOAD_SECRET)
  if (!authorized) return NextResponse.json({ error: 'Development route disabled.' }, { status: 404 })
  try {
    const summary = await seedTeableDatabases()
    return NextResponse.json(summary)
  } catch (error) {
    console.error('Teable seed failed:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Teable seed failed.' }, { status: 500 })
  }
}
