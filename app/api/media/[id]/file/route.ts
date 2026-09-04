import fs from 'node:fs/promises'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { canUserReadMedia } from '@/lib/media/access'
import { MEDIA_STATIC_DIR } from '@/collections/Media'

// Reads a real file from disk on every request — never Edge.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The actual bytes, authenticated by THIS APP rather than by Payload.
 *
 * Payload's own upload machinery already serves a collection's files at
 * `/api/<slug>/file/<filename>` through the generic catch-all
 * (`app/(payload)/api/[...slug]/route.ts`) — confirmed live while building
 * this (`media.url` really does resolve to that path). It is unusable here
 * for exactly the reason `collections/Media.ts`'s header explains at length:
 * that path's access check runs against Payload's OWN `req.user`, which is
 * always null for a browser that only ever authenticated with Better Auth.
 * Every `<img>`/link this app hands to a client therefore points HERE
 * instead, addressed by id (not filename, which is not guaranteed unique
 * across a re-upload race the way an id is) — this route resolves the id to
 * the right file on disk itself and applies `canUserReadMedia`, the channel-
 * aware rule Payload's own collection-level `access.read` cannot express
 * because it has no notion of `team_messages.attachments`.
 *
 * `?size=thumbnail` serves the bounded preview variant `collections/Media.ts`
 * configures; anything else (including no param) serves the original.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentPayloadUser()
  if (!user) return new NextResponse('Unauthorized', { status: 401 })

  const { id: idParam } = await params
  const id = Number(idParam)
  if (!Number.isFinite(id)) return new NextResponse('Not found', { status: 404 })

  const payload = await getPayloadClient()
  const media = await payload.findByID({ collection: 'media', id, overrideAccess: true, disableErrors: true })
  if (!media) return new NextResponse('Not found', { status: 404 })

  if (!(await canUserReadMedia(user.id, media))) return new NextResponse('Not found', { status: 404 })

  const size = req.nextUrl.searchParams.get('size')
  const filename = size === 'thumbnail' ? media.sizes?.thumbnail?.filename : media.filename
  const mimeType = size === 'thumbnail' ? media.sizes?.thumbnail?.mimeType ?? media.mimeType : media.mimeType
  if (!filename) return new NextResponse('Not found', { status: 404 })

  // `path.basename` — a filename that ever contained `..` or a separator
  // would let this route escape `MEDIA_STATIC_DIR`. Payload's own
  // `getSafeFilename` already sanitises on write; this is the second gate on
  // the read side, which costs nothing and closes the hole even if that ever
  // changes upstream.
  const resolved = path.join(MEDIA_STATIC_DIR, path.basename(filename))
  let bytes: Buffer
  try {
    bytes = await fs.readFile(resolved)
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': mimeType ?? 'application/octet-stream',
      'Content-Length': String(bytes.length),
      // Private: this is per-viewer-authorized content, never a shared CDN
      // cache. A short max-age still saves a repeat fetch of the same
      // message within one session without risking a stale 404 outliving a
      // permission change.
      'Cache-Control': 'private, max-age=300',
    },
  })
}
