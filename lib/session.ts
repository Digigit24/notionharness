import { headers } from 'next/headers'
import { auth } from '@/lib/auth'

// Server Component / Server Action session check. Deliberately not done in
// middleware: middleware runs on the Edge runtime by default, and the `pg`
// Pool driving `auth` needs a real Node.js TCP socket, so it can't run there.
export async function getSession() {
  return auth.api.getSession({ headers: await headers() })
}
