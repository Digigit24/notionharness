import { NextRequest, NextResponse } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { canUserReadMedia } from '@/lib/media/access'

export const runtime = 'nodejs'

/**
 * Metadata for one attachment — what `components/thread/Attachment.tsx`'s
 * `ChannelAttachment` wrapper fetches to turn a bare Media id (all a sent
 * message ever carries; see `lib/broker/channels.ts`) into the name/size/type
 * that component already knows how to render.
 *
 * A genuine HTTP route rather than a server action for the SAME reason
 * `[id]/file/route.ts` is: `message-row.tsx` renders many of these at once
 * inside a plain `<img>`-shaped tree, and a route is what a client component
 * can `fetch()` directly with its ambient session cookie — no action wiring,
 * no prop-drilling a server-fetched value down through a client tree.
 *
 * Auth is this app's OWN session (Better Auth via `getCurrentPayloadUser`),
 * never Payload's — see `collections/Media.ts`'s header for why a Payload
 * session never exists in this browser at all.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentPayloadUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id: idParam } = await params
  const id = Number(idParam)
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const payload = await getPayloadClient()
  const media = await payload.findByID({ collection: 'media', id, overrideAccess: true, disableErrors: true })
  if (!media) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!(await canUserReadMedia(user.id, media))) {
    // Same "same answer as missing" posture the channel routes already use
    // for a private room (`requireChannel`, `app/api/teams/.../route.ts`) —
    // telling a non-member that a file exists at all is the leak.
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({
    id: media.id,
    filename: media.filename ?? 'file',
    mimeType: media.mimeType ?? 'application/octet-stream',
    filesize: media.filesize ?? 0,
    width: media.width ?? null,
    height: media.height ?? null,
    url: `/api/media/${media.id}/file`,
    thumbnailUrl: media.sizes?.thumbnail?.filename ? `/api/media/${media.id}/file?size=thumbnail` : null,
  })
}
