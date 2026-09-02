// ROADMAP B5.1 — home surface "what I was doing" / recent pages. No
// per-user "recently viewed page" tracking exists server-side today (checked
// lib/pages-cache.ts and the `activity` collection: activity records actions
// like "created"/"renamed", not "viewed", and isn't per-viewer). Per this
// batch's own brief, a localStorage-based recent-pages list is the accepted
// pragmatic choice here — same "prefer localStorage for per-viewer UI
// conveniences over inventing backend infra" posture the sidebar's own
// collapsed/expanded state and last-Work-subroute already use (see
// components/sidebar/sidebar.tsx). Scoped per workspace slug so switching
// workspaces doesn't mix unrelated recent-page lists, and deliberately client-
// only: nothing here is safe to call from a Server Component (no
// `localStorage`), and it must never be imported by one.

export interface RecentPageEntry {
  id: number
  title: string
  icon: string | null
  visitedAt: string
}

const MAX_ENTRIES = 6

function storageKey(workspaceSlug: string): string {
  return `notionforge:recent-pages:${workspaceSlug}`
}

export function recordRecentPageVisit(
  workspaceSlug: string,
  entry: { id: number; title: string; icon: string | null },
): void {
  if (typeof window === 'undefined') return
  try {
    const existing = getRecentPageVisits(workspaceSlug).filter((e) => e.id !== entry.id)
    const next: RecentPageEntry[] = [
      { id: entry.id, title: entry.title, icon: entry.icon, visitedAt: new Date().toISOString() },
      ...existing,
    ].slice(0, MAX_ENTRIES)
    window.localStorage.setItem(storageKey(workspaceSlug), JSON.stringify(next))
  } catch {
    // localStorage can throw in a private window or when disabled — a
    // best-effort per-viewer convenience isn't worth failing the page over.
  }
}

export function getRecentPageVisits(workspaceSlug: string): RecentPageEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceSlug))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is RecentPageEntry =>
        e && typeof e.id === 'number' && typeof e.title === 'string' && typeof e.visitedAt === 'string',
    )
  } catch {
    return []
  }
}
