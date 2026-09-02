/**
 * Shared helpers for the transcript pipeline.
 *
 * Pure functions only — no DOM, no React, no I/O. Everything in
 * `lib/transcript/*` imports from here.
 */

/** Apply a list of regex replacements across an input string. */
export function applyReplacements(input: string, patterns: readonly RegExp[]): string {
  let out = input
  for (const re of patterns) {
    out = out.replace(re, '[REDACTED]')
  }
  return out
}

/**
 * A compact, opinionated set of regexes that catch the common secret
 * shapes we actually care about for transcript display: bearer tokens,
 * AWS / GitHub / Stripe keys, PEM private key blocks, generic
 * key=value/URL query-string auth params, and long opaque base64/hex
 * runs. Intentionally conservative — false positives are cheaper than
 * showing a real credential on screen.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // Authorization: Bearer / Basic header (full header line)
  /(?:authorization\s*:\s*)(?:bearer|basic)\s+[A-Za-z0-9._\-+/=]+/gi,
  // Standalone "Bearer <token>" / "Basic <token>" prefixes (no header prefix)
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{12,}/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub personal access token / fine-grained token / OAuth
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  // Stripe live + test secret/publishable keys
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens (xox[abprs]-...)
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // PEM private key block
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Common key=value or query-string params: ?api_key=... &token=... apikey=... password=... secret=...
  // Captures the key name and the value, replaces the whole match.
  /\b(?:api_?key|access_?token|auth(?:_?token)?|password|secret|signature|sid|token)(?:\s*[:=]\s*|\"\s*:\s*\")[^\s"',;}{)]{6,}/gi,
  // Long opaque hex / base64-ish runs (>= 32 chars, no whitespace inside)
  /\b[A-Za-z0-9+/=]{32,}\b/g,
]

/** Redact secrets in any string-typed field of an arbitrary value (recursive). */
export function redactSecretsInValue<T>(value: T): T {
  if (typeof value === 'string') {
    return applyReplacements(value, SECRET_PATTERNS) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsInValue(item)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretsInValue(v)
    }
    return out as unknown as T
  }
  return value
}

/**
 * Format a cost value in "ticks" as a USD string.
 *
 * Per the canonical RunEvent `usage` shape, `costTicks` is a non-negative
 * integer; we treat 100 ticks = $1.00 (so 438 ticks → "$4.38"). This
 * matches the example string the roadmap P5.6 brief calls out.
 */
export function formatCostUSD(costTicks: number): string {
  const safe = Math.max(0, Math.round(costTicks))
  const dollars = safe / 100
  return `$${dollars.toFixed(2)}`
}

/**
 * Stable, side-effect-free comparison for the rare "are these two values
 * structurally equal?" needs in the pipeline. Not a deep object-identity
 * check — it short-circuits on primitives and recurses on arrays/objects.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  if (ak.length !== Object.keys(bo).length) return false
  for (const k of ak) {
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}
