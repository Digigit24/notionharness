// C1.0 — real, automated coverage for the env allowlist/denylist that now
// gates every spawned agent binary and terminal session (see spawn-env.ts's
// own header comment for the vulnerability this closes: every spawn site
// used to pass the full server `process.env` through unfiltered).

import { describe, expect, it, afterEach } from 'vitest'
import { buildSpawnEnv, filterSpawnEnv } from '@/lib/hermes/spawn-env'

const ORIGINAL_ENV = { ...process.env }

// `process.env` is typed as `NodeJS.ProcessEnv`, which requires `NODE_ENV`
// to statically be present — a test fixture replacing the whole object has
// no reason to carry it (see filterSpawnEnv's own doc comment for the
// identical reasoning). This cast is scoped to test setup only.
function setEnv(env: Record<string, string | undefined>): void {
  process.env = env as NodeJS.ProcessEnv
}

afterEach(() => {
  setEnv({ ...ORIGINAL_ENV })
})

describe('filterSpawnEnv', () => {
  it('keeps allowlisted keys', () => {
    const result = filterSpawnEnv({ PATH: '/usr/bin', HOME: '/home/user', TERM: 'xterm-256color' })
    expect(result).toEqual({ PATH: '/usr/bin', HOME: '/home/user', TERM: 'xterm-256color' })
  })

  it('drops keys not on the allowlist', () => {
    const result = filterSpawnEnv({ PATH: '/usr/bin', SOME_RANDOM_VAR: 'value' })
    expect(result).toEqual({ PATH: '/usr/bin' })
  })

  it('strips real secret-shaped keys even though this repo never allowlists them', () => {
    const result = filterSpawnEnv({
      DATABASE_URI: 'postgres://user:pass@host/db',
      PAYLOAD_SECRET: 'shh',
      BETTER_AUTH_SECRET: 'shh',
      HERMES_API_KEY: 'sk-live-xxx',
      TEABLE_API_KEY: 'tk-xxx',
      PATH: '/usr/bin',
    })
    expect(result).toEqual({ PATH: '/usr/bin' })
  })

  it('the denylist wins even for a key that would otherwise be allowlisted', () => {
    // Synthetic case: proves the denylist is checked independently of the
    // allowlist, not just "everything not on the allowlist" — a future
    // allowlist addition shaped like a secret (e.g. a hypothetical
    // 'HOME_TOKEN') still gets stripped.
    const result = filterSpawnEnv({ PATH: '/usr/bin', PATH_TOKEN: 'nope' })
    expect(result).toEqual({ PATH: '/usr/bin' })
  })

  it('matches allowlisted keys case-insensitively (Windows env casing varies)', () => {
    const result = filterSpawnEnv({ Path: 'C:\\Windows', ComSpec: 'C:\\cmd.exe' })
    expect(result).toEqual({ Path: 'C:\\Windows', ComSpec: 'C:\\cmd.exe' })
  })

  it('drops keys with an undefined value', () => {
    const result = filterSpawnEnv({ PATH: '/usr/bin', HOME: undefined })
    expect(result).toEqual({ PATH: '/usr/bin' })
  })

  it('returns an empty object for an env with nothing allowlisted', () => {
    expect(filterSpawnEnv({ SECRET_TOKEN: 'x', RANDOM: 'y' })).toEqual({})
  })
})

describe('buildSpawnEnv', () => {
  it('filters the real process.env down to the safe subset', () => {
    setEnv({ PATH: '/usr/bin', DATABASE_URI: 'postgres://leak', PAYLOAD_SECRET: 'leak' })
    const result = buildSpawnEnv()
    expect(result).toEqual({ PATH: '/usr/bin' })
  })

  it('overlays explicit overrides on top of the filtered base, even for non-allowlisted names', () => {
    setEnv({ PATH: '/usr/bin' })
    const result = buildSpawnEnv({ ANTHROPIC_API_KEY: 'sk-explicit', HERMES_HOME: '/tmp/home-overlay' })
    expect(result).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-explicit', HERMES_HOME: '/tmp/home-overlay' })
  })

  it('an override of undefined deletes an inherited key rather than passing it through', () => {
    setEnv({ PATH: '/usr/bin', TERM: 'xterm' })
    const result = buildSpawnEnv({ TERM: undefined })
    expect(result).toEqual({ PATH: '/usr/bin' })
  })

  it('overrides are trusted verbatim, unlike the base env — callers must not spread process.env into them', () => {
    // Documents the actual discipline this fix depends on: buildSpawnEnv
    // filters `process.env` but deliberately does NOT filter `overrides`,
    // since overrides are meant to carry real, intentional values (a
    // provider API key). run-with-identity.ts used to spread `process.env`
    // into its own override object before calling this — which would have
    // defeated filtering entirely, since the resulting override already
    // contained every secret. That call site no longer does this; this
    // test just proves overrides really do pass through unfiltered, so the
    // guarantee lives in "don't spread process.env into overrides," not in
    // this function silently protecting against it.
    setEnv({ PATH: '/usr/bin' })
    const secretShapedOverride = { DATABASE_URI: 'postgres://leak-if-a-caller-ever-does-this' }
    const result = buildSpawnEnv(secretShapedOverride)
    expect(result).toEqual({ PATH: '/usr/bin', DATABASE_URI: 'postgres://leak-if-a-caller-ever-does-this' })
  })
})
