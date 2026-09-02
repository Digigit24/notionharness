import { hermesPost } from '@/lib/hermes-api'

// See app/api/hermes/memories/route.ts's header for the inferred-shape note.
// Mirrors skills/save/route.ts exactly; body is forwarded to Hermes as-is
// (expected shape: { profile, name, content }).
export async function POST(req: Request) {
  const body = await req.json()
  return hermesPost('/api/memories/save', body)
}
