import { hermesGet } from '@/lib/hermes-api'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = searchParams.get('limit')

  const params: Record<string, string | undefined> = {}
  if (limit) params.limit = limit

  return hermesGet('/api/crons/recent', params)
}
