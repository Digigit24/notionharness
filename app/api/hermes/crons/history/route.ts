import { hermesGet } from '@/lib/hermes-api'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const jobId = searchParams.get('job_id')

  const params: Record<string, string | undefined> = {}
  if (jobId) params.job_id = jobId

  return hermesGet('/api/crons/history', params)
}
