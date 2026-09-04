import { hermesPost } from '@/lib/runtimes/hermes/api-proxy'

export async function POST(req: Request) {
  const body = await req.json()
  return hermesPost('/api/skills/toggle', body)
}
