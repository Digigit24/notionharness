import 'server-only'
import fs from 'node:fs'
import path from 'node:path'

let cached: string | null = null

/**
 * The build THIS server process is serving.
 *
 * Read once and held for the life of the process, deliberately: `next build`
 * rewrites `.next/BUILD_ID` while an already-running `next start` keeps
 * serving the build it loaded at boot. Re-reading the file per request would
 * report the build on DISK, which in that window is not the build being
 * served — and the whole point of exposing this (see
 * `components/app/stale-build-notice.tsx`) is for a browser tab to compare
 * itself against what the server will actually answer with.
 *
 * `next dev` has no meaningful build id (HMR keeps a dev tab current on its
 * own); the sentinel tells the client to skip the check entirely.
 */
export function getBuildId(): string {
  if (cached) return cached
  try {
    cached = fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || 'development'
  } catch {
    cached = 'development'
  }
  return cached
}
