'use client'

import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { PopoverMenu } from '@/components/ui/popover-menu'
import { toast } from '@/hooks/use-toast'
import { noteStaleBuildError } from '@/components/app/stale-build-notice'
import { unwrap } from '@/lib/failures'
import { uploadMediaAction } from '@/app/api/media/actions'

const MAX_COVER_BYTES = 15 * 1024 * 1024

/**
 * Gallery of preset gradients ("randomizer"), a real file upload (via the
 * same `uploadMediaAction`/Media pipeline the channel composer's
 * attachments already use — see that action's own docstring), and a
 * paste-a-URL fallback for an already-hosted image. Values are prefixed so
 * `PageCanvas` can tell a gradient (`gradient:...`), an uploaded file
 * (`media:<id>`, resolved to this app's own `/api/media/<id>/file` route),
 * and a plain external URL apart from each other.
 */
export const COVER_GRADIENTS = [
  'gradient:from-orange-200 to-pink-200',
  'gradient:from-blue-200 to-cyan-200',
  'gradient:from-purple-200 to-indigo-200',
  'gradient:from-green-200 to-emerald-200',
  'gradient:from-yellow-200 to-orange-200',
  'gradient:from-rose-200 to-fuchsia-200',
  'gradient:from-slate-300 to-slate-100',
  'gradient:from-teal-200 to-lime-200',
]

export function CoverPicker({
  workspaceId,
  onSelect,
  trigger,
}: {
  workspaceId: number
  onSelect: (value: string) => void
  trigger: string
}) {
  const [url, setUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    if (file.size > MAX_COVER_BYTES) {
      toast({
        title: 'That image is too large',
        description: `Covers are capped at ${Math.floor(MAX_COVER_BYTES / (1024 * 1024))} MB.`,
        variant: 'destructive',
      })
      return
    }
    setUploading(true)
    try {
      const formData = new FormData()
      formData.set('file', file)
      formData.set('workspaceId', String(workspaceId))
      const uploaded = unwrap(await uploadMediaAction(formData))
      onSelect(`media:${uploaded.id}`)
    } catch (err) {
      noteStaleBuildError(err)
      toast({
        title: "Couldn't upload that image",
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setUploading(false)
    }
  }

  return (
    <PopoverMenu
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1.5 rounded-md bg-black/40 px-2 py-1 text-xs text-white hover:bg-black/60"
        >
          {trigger}
        </button>
      )}
    >
      {(close) => (
        <div className="w-72 p-2">
          <div className="mb-2 flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                // Closes the popover once the upload actually lands, not on
                // click — an image that streamed for a second with the
                // popover still open (and a spinner saying so) beats one
                // that vanished mid-upload with nothing on screen to explain
                // why the cover hasn't changed yet.
                void handleFile(file).then(() => close())
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded bg-black/[.06] px-2 py-1.5 text-xs font-medium hover:bg-black/10 disabled:opacity-60 dark:bg-white/10 dark:hover:bg-white/20"
            >
              {uploading && <Loader2 size={12} className="animate-spin" />}
              {uploading ? 'Uploading…' : 'Upload an image'}
            </button>
          </div>

          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-black/50 dark:text-white/50">Gallery</span>
            <button
              type="button"
              onClick={() => {
                onSelect(COVER_GRADIENTS[Math.floor(Math.random() * COVER_GRADIENTS.length)])
                close()
              }}
              className="rounded bg-black/[.06] px-2 py-0.5 text-xs hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            >
              Random
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {COVER_GRADIENTS.map((c) => (
              <button
                key={c}
                type="button"
                title="Use this cover"
                onClick={() => {
                  onSelect(c)
                  close()
                }}
                className={`h-10 rounded bg-gradient-to-br ${c.replace('gradient:', '')}`}
              />
            ))}
          </div>
          <div className="mt-2 flex gap-1">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste an image URL..."
              aria-label="Paste an image URL"
              className="min-w-0 flex-1 rounded border border-black/10 bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-white/10"
            />
            <button
              type="button"
              onClick={() => {
                if (url.trim()) {
                  onSelect(url.trim())
                  close()
                }
              }}
              className="shrink-0 rounded bg-black/[.06] px-2 text-xs hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            >
              Use
            </button>
          </div>
        </div>
      )}
    </PopoverMenu>
  )
}
