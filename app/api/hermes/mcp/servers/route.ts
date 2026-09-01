import { hermesGet } from '@/lib/hermes-api'

export async function GET() {
  return hermesGet('/api/mcp/servers')
}
