import { hermesGet } from '@/lib/runtimes/hermes/api-proxy'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const name = searchParams.get('name')
  const file = searchParams.get('file')

  if (!name) {
    return new Response(JSON.stringify({ error: 'name query parameter required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const params: Record<string, string | undefined> = { name }
  if (file) params.file = file

  return hermesGet('/api/skills/content', params)
}
