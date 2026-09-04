import { hermesGet, hermesPost, hermesPatch, hermesDelete } from '@/lib/runtimes/hermes/api-proxy'
import { requireHermesAccess } from '../guard'

export async function GET(req: Request) {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  const { searchParams } = new URL(req.url)
  const allProfiles = searchParams.get('all_profiles')

  const params: Record<string, string | undefined> = {}
  if (allProfiles) params.all_profiles = allProfiles

  return hermesGet('/api/crons', params)
}

export async function POST(req: Request) {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  const body = await req.json()
  return hermesPost('/api/crons/create', body)
}

export async function PATCH(req: Request) {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  const body = await req.json()
  return hermesPatch('/api/crons/update', body)
}

export async function DELETE(req: Request) {
  const refusal = await requireHermesAccess()
  if (refusal) return refusal

  const body = await req.json()
  return hermesDelete('/api/crons/delete', body)
}
