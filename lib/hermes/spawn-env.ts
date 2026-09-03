// A spawned agent binary, and any command an agent runs inside an ACP
// `terminal/create` session, can read whatever environment we hand it —
// including via a plain `env`/`printenv`/`Get-ChildItem Env:` inside that
// terminal. Every spawn site in this codebase (`acp-client.ts`'s
// `spawnBinary` and its `terminal/create` handler, `run-with-identity.ts`,
// `lib/terminal/pty-server.ts`) used to pass the ENTIRE Next.js server
// `process.env` through unfiltered — DATABASE_URI, PAYLOAD_SECRET,
// BETTER_AUTH_SECRET, HERMES_API_KEY, the Teable keys, all of it, readable
// by literally any agent run or terminal session. This module is the fix:
// an explicit allowlist of the small set of env vars a spawned process
// actually needs to function (PATH, shell/locale basics, the Windows
// system vars most CLI tools silently assume exist), then a denylist that
// wins even over the allowlist — a second line of defense if the allowlist
// is ever loosened carelessly, not the primary mechanism.
//
// Anything a run genuinely needs beyond this baseline (a model provider's
// API key, a runtime profile's own config) flows through each call site's
// existing explicit per-call `env` overlay (a real, intentional value the
// caller supplies), never through implicit inheritance from the server's
// own environment.

const ALLOWED_ENV_KEYS = new Set(
  [
    // POSIX/shell basics every spawned binary needs to find other binaries
    // and behave sanely.
    'PATH',
    'HOME',
    'SHELL',
    'TERM',
    'COLORTERM',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'NODE_ENV',
    // Windows equivalents/extras — most CLI tools and shells misbehave, or
    // fail to start at all, without these present.
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'DRIVERDATA',
    'USERNAME',
    'USERDOMAIN',
    'COMPUTERNAME',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
  ].map((key) => key.toUpperCase()),
)

// Matched case-insensitively against the raw key. Wins even over an
// allowlist hit.
const DENIED_KEY_PATTERN =
  /secret|password|passwd|token|api[_-]?key|private[_-]?key|access[_-]?key|database|_uri$|^db_|credential/i

/**
 * Filters a full process-style env object down to the safe subset a
 * spawned agent binary or terminal session should inherit. Takes a plain
 * `Record<string, string | undefined>`, not `NodeJS.ProcessEnv` itself —
 * that interface requires `NODE_ENV` to be present, which a test fixture
 * or a partial snapshot of `process.env` has no reason to carry (see the
 * identical reasoning on `SendTurnOptions.env` in `./acp-client.ts`).
 */
export function filterSpawnEnv(source: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (DENIED_KEY_PATTERN.test(key)) continue
    if (!ALLOWED_ENV_KEYS.has(key.toUpperCase())) continue
    result[key] = value
  }
  return result
}

/**
 * Builds the final env for a spawned process: the allowlisted subset of
 * this server's own environment, overlaid with explicit per-call overrides
 * (a runtime profile's configured API key, an agent's customEnv, ACP's
 * `params.env`, `HERMES_HOME`). Overrides are trusted as explicit and are
 * never filtered — only inheritance from the raw server environment is.
 * `undefined` in `overrides` deletes that key from the result.
 */
export function buildSpawnEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env = filterSpawnEnv(process.env)
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}
