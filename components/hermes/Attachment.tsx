'use client'

import { ReactNode } from 'react'
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
