/**
 * Coarse "2 days ago"-style relative time, with no external date dependency
 * (checked `package.json` — no date-fns/dayjs/luxon/moment in this repo, and
 * this file must be importable from a client component, so it can't pull in
 * one just for this). Deliberately minute-level-or-coarser precision — the
 * ROADMAP B-2 hover chip's own example ("2 days ago") never needed
 * second-level accuracy, and a stable string avoids the chip's text
 * re-rendering every tick.
 *
 * Pure and side-effect-free on purpose: safe to import from both a server
 * module (`lib/provenance.ts`) and a `'use client'` component (the hover
 * chip re-derives display text from the same ISO timestamp rather than
 * trusting a string baked in at server-render time, which would go stale
 * for a page left open).
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'unknown time'

  const diffMs = now - then
  if (diffMs < 60_000) return 'just now'

  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  const month = 30 * day
  const year = 365 * day

  const pluralize = (value: number, unit: string) => `${value} ${unit}${value === 1 ? '' : 's'} ago`

  if (diffMs < hour) return pluralize(Math.floor(diffMs / minute), 'minute')
  if (diffMs < day) return pluralize(Math.floor(diffMs / hour), 'hour')
  if (diffMs < week) return pluralize(Math.floor(diffMs / day), 'day')
  if (diffMs < month) return pluralize(Math.floor(diffMs / week), 'week')
  if (diffMs < year) return pluralize(Math.floor(diffMs / month), 'month')
  return pluralize(Math.floor(diffMs / year), 'year')
}
