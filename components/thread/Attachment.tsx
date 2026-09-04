'use client'

import { ReactNode, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Attachment component for displaying files/attachments in chat
 * Extensible for custom attachment types
 */
export interface AttachmentProps {
  type?: 'file' | 'image' | 'code' | 'link'
  name?: string
  url?: string
  size?: number
  mimeType?: string
  preview?: ReactNode
  className?: string
}

export function Attachment({
  type = 'file',
  name,
  url,
  size,
  mimeType,
  preview,
  className,
}: AttachmentProps) {
  const typeIcons = {
    file: '📄',
    image: '🖼️',
    code: '💻',
    link: '🔗',
  }

  const formatSize = (bytes?: number): string => {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2 p-3 rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">{typeIcons[type]}</span>
        <div className="flex-1 min-w-0">
          {name && <div className="truncate font-medium text-sm">{name}</div>}
          {mimeType && <div className="text-xs text-gray-500 dark:text-gray-400">{mimeType}</div>}
        </div>
        {size && <div className="text-xs text-gray-500">{formatSize(size)}</div>}
      </div>

      {preview && <div className="mt-2 max-w-full overflow-auto">{preview}</div>}

      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          Open →
        </a>
      )}
    </div>
  )
}

/**
 * R14-P0.4 — completes `Attachment` rather than replacing it.
 *
 * A sent `team_messages` row carries `attachments: number[]` — Media
 * collection ids, and nothing else (`lib/broker/channels.ts`'s own comment
 * explains why: one copy of a file's bytes/name/size, never duplicated onto
 * the message). So rendering one on a real message needs a step `Attachment`
 * itself was never meant to do: turning that bare id into the
 * name/url/size/mimeType props it already knows how to draw. This is that
 * step, as a small wrapper rather than a second component with its own look —
 * every attachment in this app still renders through the one `Attachment`
 * body above.
 *
 * A CLIENT fetch to `/api/media/[id]` (not a server component) because the
 * one place this is meant to be dropped in — a message row inside the
 * channel feed — is itself a client component tree (`channel-view.tsx`), and
 * a server component cannot be mounted from inside one without becoming a
 * boundary the caller would have to restructure around. The route is
 * authenticated with this app's own session and re-derives visibility from
 * `lib/media/access.ts`'s `canUserReadMedia`, so a 404 here means "you may
 * not see this," not "something broke" — rendered as a quiet placeholder
 * rather than an error state, the same posture `MailX`/undeliverable rows
 * already take elsewhere in this feed.
 */
export interface ResolvedAttachmentMeta {
  id: number
  filename: string
  mimeType: string
  filesize: number
  width: number | null
  height: number | null
  url: string
  thumbnailUrl: string | null
}

const attachmentMetaCache = new Map<number, ResolvedAttachmentMeta>()

export function ChannelAttachment({ mediaId, className }: { mediaId: number; className?: string }) {
  const [meta, setMeta] = useState<ResolvedAttachmentMeta | null>(attachmentMetaCache.get(mediaId) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (attachmentMetaCache.has(mediaId)) return
    let cancelled = false
    setFailed(false)
    fetch(`/api/media/${mediaId}`)
      .then((res) => (res.ok ? (res.json() as Promise<ResolvedAttachmentMeta>) : Promise.reject(res.status)))
      .then((data) => {
        if (cancelled) return
        attachmentMetaCache.set(mediaId, data)
        setMeta(data)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [mediaId])

  if (failed) {
    return (
      <div className={cn('rounded border border-black/10 px-2 py-1 text-xs text-black/40 dark:border-white/10 dark:text-white/40', className)}>
        Attachment unavailable
      </div>
    )
  }

  if (!meta) {
    return (
      <div className={cn('h-14 w-40 animate-pulse rounded border border-black/10 bg-black/[.03] dark:border-white/10 dark:bg-white/[.04]', className)} />
    )
  }

  const isImage = meta.mimeType.startsWith('image/')
  return (
    <Attachment
      className={className}
      type={isImage ? 'image' : 'file'}
      name={meta.filename}
      url={meta.url}
      size={meta.filesize}
      mimeType={meta.mimeType}
      preview={
        isImage ? (
          // An authenticated, per-viewer-authorized route (see
          // `[id]/file/route.ts`'s own comment), not a static asset
          // next/image's optimizer would be allowed to cache.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={meta.thumbnailUrl ?? meta.url}
            alt={meta.filename}
            className="max-h-48 w-auto rounded object-contain"
          />
        ) : undefined
      }
    />
  )
}
