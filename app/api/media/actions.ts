'use server'

import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { can, loadAccess } from '@/lib/permissions'
import { guard, raise, type WithFailure } from '@/lib/failures'

/**
 * R14-P0.4 — turning a `File` the composer holds into a real Media doc.
 *
 * A server action, not a route: `formData.get('file')` on a Next.js server
 * action already gives back a real `File` with `.arrayBuffer()`, so there is
 * no multipart-parsing problem here for a route to solve — the "route instead
 * of an action" carve-out in this unit's brief is for BYTE SERVING
 * (`[id]/file/route.ts`), where a plain `<img src>` cannot invoke an action at
 * all, not for the upload itself.
 *
 * `guard()`/`raise()` throughout, same as every other action in this app
 * (`lib/failures.ts`) — a thrown error from a server action never reaches a
 * production browser with its message intact.
 */

/** Matches `collections/Media.ts`'s own `upload.filesize.max` — kept as its
 * own constant here so the refusal is a clean `invalid_input` sentence
 * instead of whatever Payload's internal multer-level rejection says. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

export interface UploadedAttachment {
  id: number
  filename: string
  mimeType: string
  filesize: number
  width: number | null
  height: number | null
  /** This app's OWN serving route — never Payload's own `url`/`thumbnailURL`
   * fields, which point at Payload's default `/api/media/file/<name>` REST
   * path. That path is gated by Payload's OWN access control, evaluated
   * against `req.user`, which is always null for a browser that only ever
   * logged into Better Auth (see `collections/Media.ts`'s header comment) —
   * so every URL this app hands to a client MUST be one of its own routes. */
  url: string
  thumbnailUrl: string | null
}

function toUploadedAttachment(doc: {
  id: number
  filename?: string | null
  mimeType?: string | null
  filesize?: number | null
  width?: number | null
  height?: number | null
  sizes?: { thumbnail?: { filename?: string | null } | null } | null
}): UploadedAttachment {
  return {
    id: doc.id,
    filename: doc.filename ?? 'file',
    mimeType: doc.mimeType ?? 'application/octet-stream',
    filesize: doc.filesize ?? 0,
    width: doc.width ?? null,
    height: doc.height ?? null,
    url: `/api/media/${doc.id}/file`,
    thumbnailUrl: doc.sizes?.thumbnail?.filename ? `/api/media/${doc.id}/file?size=thumbnail` : null,
  }
}

/**
 * Upload one attachment into a workspace, before it is attached to any
 * message. The composer calls this the instant a file is chosen/dropped/
 * pasted — see this function's own docstring in `message-composer.tsx` for
 * why that is what makes the attachment feel optimistic rather than blocking
 * the whole send on a slow upload.
 */
export async function uploadMediaAction(formData: FormData): Promise<WithFailure<UploadedAttachment>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const workspaceId = Number(formData.get('workspaceId'))
    if (!Number.isFinite(workspaceId)) raise('invalid_input', 'Missing workspace.')

    const access = await loadAccess(user.id, workspaceId)
    // `write`, not `read`: attaching a file is the same class of action as
    // posting a message, and a viewer may read a channel without being able
    // to post into it.
    if (!can(access, 'write', 'workspace')) raise('forbidden', 'That workspace is not yours.')

    const file = formData.get('file')
    if (!(file instanceof File)) raise('invalid_input', 'No file was attached.')
    if (file.size === 0) raise('invalid_input', 'That file is empty.')
    if (file.size > MAX_ATTACHMENT_BYTES) {
      raise('invalid_input', `Attachments are capped at ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const payload = await getPayloadClient()
    const created = await payload.create({
      collection: 'media',
      data: { workspace: workspaceId, uploadedBy: user.id },
      file: {
        data: buffer,
        mimetype: file.type || 'application/octet-stream',
        name: file.name || 'file',
        size: buffer.length,
      },
      overrideAccess: true,
    })

    return toUploadedAttachment(created)
  })
}
