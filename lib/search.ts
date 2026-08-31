import type { Page } from '@/payload-types'

/** Calls the real full-text search API for the Cmd+K modal. */
export async function searchPages(query: string, workspaceId: number): Promise<Page[]> {
  const q = query.trim()
  if (!q) return []

  const params = new URLSearchParams({ q, workspaceId: String(workspaceId) })
  const res = await fetch(`/api/search?${params.toString()}`)
  if (!res.ok) return []

  const data = (await res.json()) as { docs?: Page[] }
  return data.docs ?? []
}
