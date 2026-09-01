import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

export async function resolveTable(tableId: string) {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'teable-databases',
    where: { teableTableId: { equals: tableId } },
    limit: 1,
    overrideAccess: true,
  })
  const doc = result.docs[0] as unknown as { teableBaseId?: string; workspace?: number }
  return doc ? { doc, baseId: doc.teableBaseId } : null
}

export function configError() {
  return NextResponse.json({ error: 'Teable is not configured on the server.' }, { status: 500 })
}

export async function teableFetch(path: string, init?: RequestInit) {
  const apiUrl = process.env.TEABLE_API_URL
  const apiKey = process.env.TEABLE_API_KEY
  if (!apiUrl || !apiKey) return { response: configError(), ok: false as const }
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${apiKey}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, { ...init, headers, cache: 'no-store' })
  return { response, ok: true as const }
}

export async function upstreamResponse(response: Response) {
  const text = await response.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = { error: text || response.statusText } }
  return NextResponse.json(body, { status: response.ok ? response.status : 502 })
}

export async function parseBody(req: Request) {
  return req.json().catch(() => null) as Promise<Record<string, unknown> | null>
}
