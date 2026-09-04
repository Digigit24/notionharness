/**
 * Validate a post-authentication redirect target.
 *
 * THE ATTACK THIS CLOSES. `/signup?next=https://evil.example/login` on an
 * unvalidated implementation sends a freshly signed-up person straight to
 * somebody else's login form, with this app's domain in the link that got them
 * there. That is an open redirect, and it is worst on exactly these two pages,
 * because they are the ones an unauthenticated stranger is supposed to be sent
 * links to.
 *
 * SO ONLY A RELATIVE, SAME-ORIGIN PATH SURVIVES. It must start with a single
 * `/` and the second character must not be `/` or `\` — `//evil.example` and
 * `/\evil.example` are both protocol-relative URLs that browsers resolve to
 * another origin, and the backslash form is the one a naive `startsWith('//')`
 * check misses. Anything containing a scheme separator is rejected outright
 * rather than parsed, because deciding whether `java\nscript:` is a scheme is
 * the browser's job and browsers disagree.
 *
 * Returns null for anything it will not vouch for, and the caller falls back to
 * its own default — never to the attacker's value.
 */
/** Space through tilde: the printable ASCII range, written as a range rather
 * than as a negated control-character class so the pattern says what it ALLOWS.
 * A URL path that has reached this point is already percent-encoded, so nothing
 * legitimate falls outside it. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null
  const candidate = value.trim()
  if (candidate.length === 0 || candidate.length > 512) return null
  if (candidate[0] !== '/') return null
  if (candidate[1] === '/' || candidate[1] === '\\') return null
  // Printable ASCII only. A control character or a raw non-ASCII byte in a
  // redirect target is either an encoding trick or a bug; neither is worth
  // following, and a legitimate path is percent-encoded by the time it is here.
  if (!PRINTABLE_ASCII.test(candidate)) return null
  if (candidate.includes(':')) return null
  return candidate
}
