import { hermesGet } from '@/lib/hermes-api'

// See app/api/hermes/memories/route.ts's header for the inferred-shape note
// this whole memories/* proxy shares. Mirrors skills/content/route.ts's
// `name`+`file` query shape, with `profile` added since memory is per-agent.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const profile = searchParams.get('profile')
  const name = searchParams.get('name')

  if (!profile || !name) {
    return new Response(JSON.stringify({ error: 'profile and name query parameters are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return hermesGet('/api/memories/content', { profile, name })
}
