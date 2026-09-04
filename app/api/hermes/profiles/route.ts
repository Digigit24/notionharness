import { hermesGet } from '@/lib/runtimes/hermes/api-proxy'

export async function GET() {
  return hermesGet('/api/profiles')
}
