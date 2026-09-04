import { hermesGet } from '@/lib/runtimes/hermes/api-proxy'
import { requireHermesAccess } from '../guard'

export async function GET(req: Request) {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')

  const params: Record<string, string | undefined> = {}
  if (category) params.category = category

  return hermesGet('/api/skills', params)
}
