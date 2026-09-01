import { hermesGet, hermesPost, hermesPatch, hermesDelete } from '@/lib/hermes-api'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const allProfiles = searchParams.get('all_profiles')

  const params: Record<string, string | undefined> = {}
  if (allProfiles) params.all_profiles = allProfiles

  return hermesGet('/api/crons', params)
}

export async function POST(req: Request) {
  const body = await req.json()
  return hermesPost('/api/crons/create', body)
}

export async function PATCH(req: Request) {
  const body = await req.json()
  return hermesPatch('/api/crons/update', body)
}

export async function DELETE(req: Request) {
  const body = await req.json()
  return hermesDelete('/api/crons/delete', body)
}
