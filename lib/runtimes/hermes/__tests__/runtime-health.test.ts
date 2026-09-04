// C1.3 — coverage for `checkHermesReachability`, the pure part of the
// runtime-health writer (the DB-touching half, `refreshRuntimeForProfile`/
// `refreshAllRuntimes`, needs a real Payload client and is exercised
// against the live app instead — see AGENTS.md's Phase C notes). This is
// what decides `up` vs `down` and what an honest `profilesAvailable` count
// looks like, so it's the part most worth locking down: it must never
// report `reachable: true` on a non-2xx, and must never fabricate a
// profile count when the response shape doesn't match.
//
// `HERMES_BASE_URL`/`HERMES_API_KEY` (lib/runtimes/hermes/api-proxy.ts) are
// plain module-
// level constants, computed once from `process.env` at import time — not
// re-read per call — so stubbing `process.env` per test has no effect on
// them. Mocking `@/lib/hermes-api` with getters backed by a mutable,
// `vi.hoisted` object does: ES module bindings are live references, so
// `runtime-health.ts`'s own `import { HERMES_BASE_URL }` still sees
// whatever the getter currently returns.

import { describe, expect, it, vi, afterEach } from 'vitest'

const hermesConfig = vi.hoisted(() => ({ baseUrl: '', apiKey: '' }))

// The module these constants live in MOVED during R1's runtime-neutral
// refactor — `lib/hermes-api.ts` became
// `lib/runtimes/hermes/api-proxy.ts` — and this mock kept pointing at the old
// path. `vi.mock` on a module nobody imports is not an error, so the mock
// silently did nothing, the real constants were empty under test, and all five
// reachability cases failed while looking like a behaviour regression. Mocking
// a path is only as good as the path.
vi.mock('@/lib/runtimes/hermes/api-proxy', () => ({
  get HERMES_BASE_URL() {
    return hermesConfig.baseUrl
  },
  get HERMES_API_KEY() {
    return hermesConfig.apiKey
  },
}))

const { checkHermesReachability } = await import('@/lib/runtimes/hermes/runtime-health')

const originalFetch = global.fetch

afterEach(() => {
  hermesConfig.baseUrl = ''
  hermesConfig.apiKey = ''
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('checkHermesReachability', () => {
  it('reports unreachable, with a clear error, when Hermes is not configured', async () => {
    const result = await checkHermesReachability()
    expect(result.reachable).toBe(false)
    expect(result.error).toMatch(/not configured/i)
  })

  it('reports reachable and a real profile count on a successful array response', async () => {
    hermesConfig.baseUrl = 'https://hermes.example.test'
    hermesConfig.apiKey = 'test-key'
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ name: 'a' }, { name: 'b' }]), { status: 200 })) as typeof fetch

    const result = await checkHermesReachability()
    expect(result.reachable).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.profilesAvailable).toBe(2)
  })

  it('reports reachable but leaves profilesAvailable unset for an unrecognized response shape', async () => {
    hermesConfig.baseUrl = 'https://hermes.example.test'
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch

    const result = await checkHermesReachability()
    expect(result.reachable).toBe(true)
    expect(result.profilesAvailable).toBeUndefined()
  })

  it('reports unreachable on a non-2xx response, never treating it as up', async () => {
    hermesConfig.baseUrl = 'https://hermes.example.test'
    global.fetch = vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 })) as typeof fetch

    const result = await checkHermesReachability()
    expect(result.reachable).toBe(false)
    expect(result.statusCode).toBe(502)
    expect(result.error).toMatch(/502/)
  })

  it('reports unreachable on a network error, with the real error message', async () => {
    hermesConfig.baseUrl = 'https://hermes.example.test'
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch

    const result = await checkHermesReachability()
    expect(result.reachable).toBe(false)
    expect(result.error).toBe('ECONNREFUSED')
  })

  it('sends the configured API key as a bearer token', async () => {
    hermesConfig.baseUrl = 'https://hermes.example.test'
    hermesConfig.apiKey = 'sk-real-key'
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    await checkHermesReachability()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-real-key')
  })

  it('always includes a checkedAt timestamp, reachable or not', async () => {
    const before = Date.now()
    const result = await checkHermesReachability()
    expect(Date.parse(result.checkedAt)).toBeGreaterThanOrEqual(before)
  })
})
