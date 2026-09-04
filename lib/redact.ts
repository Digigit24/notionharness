// R3.8 — strip credentials out of text before it is logged or shown.
//
// Agent error text is not ours. It is whatever a CLI printed, which routinely
// includes the request it was making: an Authorization header, a provider key
// echoed back in a 401 body, a clone URL with a token in it. That text then
// goes three places that all outlive the turn — the server log, the `runs`
// table's `error` column, and a chat bubble a user may screenshot. A key that
// reaches any of them has leaked.
//
// The rules below are deliberately shape-based rather than a list of vendor
// prefixes. A vendor list is always out of date, and the shapes that matter —
// a bearer token, a long high-entropy value after an obviously secret-sounding
// name, credentials inside a URL — are stable.
//
// This never claims to be complete. It is a floor, not a guarantee, and the
// real protection remains not putting secrets where an agent can read them.

const PLACEHOLDER = '[redacted]'

/** Enough characters that ordinary words and short identifiers cannot match. */
const SECRET_MIN = 12

const RULES: Array<{ pattern: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  // `https://user:token@host` — the whole credential pair, not just the token,
  // because a username can be the secret with basic auth.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replace: (_m, scheme) => `${scheme}${PLACEHOLDER}@`,
  },
  // `Authorization: Bearer <token>`, and bare `Bearer <token>`.
  {
    pattern: /\b(bearer|token|basic)\s+([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (_m, kind) => `${kind} ${PLACEHOLDER}`,
  },
  // A JWT is unmistakable and always sensitive.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => PLACEHOLDER,
  },
  // `api_key=...`, `"secret": "..."`, `PASSWORD: ...` — the name carries the
  // meaning, so the shape of the value barely matters. Quotes are preserved so
  // redacted JSON stays parseable-looking rather than becoming gibberish.
  {
    pattern: new RegExp(
      String.raw`\b([A-Za-z_][A-Za-z0-9_-]*(?:api[_-]?key|apikey|secret|password|passwd|token|credential|private[_-]?key)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{${SECRET_MIN},})`,
      'gi',
    ),
    replace: (_m, name, sep) => `${name}${sep}${PLACEHOLDER}`,
  },
  // Same, but for a bare `key:`/`token:` with no prefix or suffix on the name.
  {
    pattern: new RegExp(
      String.raw`\b(api[_-]?key|apikey|secret|password|passwd|token|credential)(["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{${SECRET_MIN},})`,
      'gi',
    ),
    replace: (_m, name, sep) => `${name}${sep}${PLACEHOLDER}`,
  },
  // Vendor prefixes that are unambiguous on their own, so they are caught even
  // when they appear with no surrounding label at all. Not a complete list and
  // not meant to be — it is the layer below the shape rules, not instead.
  {
    pattern: /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => PLACEHOLDER,
  },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replace: () => PLACEHOLDER },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: () => PLACEHOLDER },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => PLACEHOLDER },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => PLACEHOLDER },
]

/**
 * Removes anything that looks like a credential from free text.
 *
 * Safe on any string, including one with no secrets in it, and cheap enough to
 * call on every error path. Returns the input unchanged when nothing matches,
 * so it never disturbs text that was already clean.
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string)
  }
  return out
}

/** Convenience for the common `unknown` caught in a catch block. */
export function redactError(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err))
}
