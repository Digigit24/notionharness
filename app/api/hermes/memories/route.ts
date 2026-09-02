import { hermesGet } from '@/lib/hermes-api'

// ROADMAP B7.1 (Batch B-6 "Finish") — memory browser proxy, built as a
// sibling of app/api/hermes/skills/route.ts against the same live Hermes
// control-plane HTTP surface (HERMES_BASE_URL/HERMES_API_KEY, see
// lib/hermes-api.ts). UNLIKE skills (a global, shared pool), memory is
// per-agent: lib/hermes/home-overlay.ts confirms Hermes keeps a real,
// persistent `memories/` directory per agent (`agentMemoryRoot/<agentId>/`,
// linked into each run's disposable HERMES_HOME overlay), not a shared pool.
//
// HONESTY NOTE (do not remove): no `/api/memories` endpoint on the live
// Hermes HTTP server has been confirmed against a running instance in this
// codebase — nothing here previously proxied it. This route's path and
// `profile` query param are inferred from the skills API's own shape
// (`/api/skills?category=`), on the assumption memories are a sibling
// resource under the same control-plane surface, keyed by whichever
// identifier Hermes uses for a profile/agent. The caller passes the agent's
// name as `profile` (the only stable identifier available client-side) —
// if Hermes actually keys profiles by a different id, this proxy still
// forwards whatever comes back, so a live mismatch will surface as an empty
// list or a 404 from Hermes, not a crash.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const profile = searchParams.get('profile')

  const params: Record<string, string | undefined> = {}
  if (profile) params.profile = profile

  return hermesGet('/api/memories', params)
}
