import { hermesGet } from '@/lib/hermes-api'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')

  const params: Record<string, string | undefined> = {}
  if (category) params.category = category

  return hermesGet('/api/skills', params)
}
