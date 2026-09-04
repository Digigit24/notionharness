import { hermesGet } from '@/lib/runtimes/hermes/api-proxy'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const freshness = searchParams.get('freshness')
  const provider = searchParams.get('provider')

  const params: Record<string, string | string[] | undefined> = {}
  if (freshness) params.freshness = freshness
  if (provider) params.provider = provider

  return hermesGet('/api/models', params)
}
