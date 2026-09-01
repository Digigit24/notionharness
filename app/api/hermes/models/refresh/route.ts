import { hermesPost } from '@/lib/hermes-api'

export async function POST(req: Request) {
  const body = await req.json()
  return hermesPost('/api/models/refresh', body)
}
