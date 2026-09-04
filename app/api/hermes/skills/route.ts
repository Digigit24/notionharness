import { hermesGet } from '@/lib/runtimes/hermes/api-proxy'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')

  const params: Record<string, string | undefined> = {}
  if (category) params.category = category

  return hermesGet('/api/skills', params)
}
