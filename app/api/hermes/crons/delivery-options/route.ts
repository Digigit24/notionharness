import { hermesGet } from '@/lib/runtimes/hermes/api-proxy'
import { requireHermesAccess } from '../../guard'

export async function GET() {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  return hermesGet('/api/crons/delivery-options')
}
