import { hermesGet } from '@/lib/runtimes/hermes/api-proxy'
import { requireHermesAccess } from '../../guard'

export async function GET(req: Request) {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  const { searchParams } = new URL(req.url)
  const jobId = searchParams.get('job_id')
  const path = searchParams.get('path')

  const params: Record<string, string | undefined> = {}
  if (jobId) params.job_id = jobId
  if (path) params.path = path

  return hermesGet('/api/crons/output', params)
}
