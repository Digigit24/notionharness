/** Compact, human durations for step badges: `840ms`, `4.2s`, `1m 12s`.
 * Sub-second work stays in milliseconds because that's the difference
 * between "instant" and "noticeable"; past a minute, seconds alone stop
 * being readable. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  // `< 60_000` is not the right boundary once the value is rounded to one
  // decimal: 59_999ms rounds to "60.0s", the same carry bug one unit up.
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`
  // Round to whole seconds FIRST, then split. Rounding the remainder after
  // flooring the minutes let the seconds reach 60: at 359_600ms that produced
  // a literal "5m 60s" on screen. Every carry has to happen before the split.
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/** Duration between two ISO timestamps, when both are present. */
export function durationBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}
