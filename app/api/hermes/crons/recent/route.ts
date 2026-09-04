import { hermesGet } from '@/lib/runtimes/hermes/api-proxy'
import { requireHermesAccess } from '../../guard'

export async function GET(req: Request) {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  const { searchParams } = new URL(req.url)
  const limit = searchParams.get('limit')

  const params: Record<string, string | undefined> = {}
  if (limit) params.limit = limit

  return hermesGet('/api/crons/recent', params)
}
