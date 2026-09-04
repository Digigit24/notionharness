import { hermesPost } from '@/lib/runtimes/hermes/api-proxy'
import { requireHermesAccess } from '../../guard'

export async function POST(req: Request) {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  const body = await req.json()
  return hermesPost('/api/skills/toggle', body)
}
