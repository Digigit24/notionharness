'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { uploadMediaAction } from '@/app/api/media/actions'
import { unwrap } from '@/lib/failures'

/**
 * File attachment upload/drag-drop/paste — factored out of
 * `components/teams/message-composer.tsx`'s own inline `ComposerAttachment`
 * state (R14-P0.4) so the Work hero composer does not reimplement the same
 * upload/drag/paste/retry dance a second time. This is genuinely the same
 * problem in both places: pick-or-drop-or-paste a file, upload it in the
 * background the instant it is added, let it be removed any time before
 * Send, and never block typing on the network.
 *
 * NOT wired into `message-composer.tsx` itself. That file is owned by a
 * sibling unit of work mid-edit on the Teams surface, and this unit's brief
 * is explicit: read it for reference, do not touch it. So today only Work's
 * composer consumes this hook; retrofitting the channel composer onto it is
 * left as follow-up work for whoever owns that file next, once it is safe to
 * touch.
 */

export interface UploadingAttachment {
  /** Client-local only — never sent anywhere. Keys the chip and matches a
   * finished upload back to the row that started it. */
  key: string
  file: File
  status: 'uploading' | 'done' | 'error'
  /** Set once the upload returns. This IS the id a send carries. */
  mediaId?: number
  filesize: number
  mimeType: string
  /** `URL.createObjectURL(file)` — an instant local preview, before the
   * network round trip even starts. Revoked on removal/unmount. */
  objectUrl: string | null
  errorMessage?: string
}

/** Matches `collections/Media.ts`'s own `upload.filesize.max` and
 * `uploadMediaAction`'s own check — restated here so an oversized file is
 * refused before a wasted upload attempt, with the same sentence the server
 * would have given anyway. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
/** Same cap `message-composer.tsx` uses — D0's "no unbounded lists" applied
 * to a single compose action. */
const MAX_ATTACHMENTS_PER_MESSAGE = 6

export function useAttachmentUploads(workspaceId: number) {
  const [attachments, setAttachments] = useState<UploadingAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // Revoke every object URL still held when the hook's owner unmounts, not
  // on every render — the same reasoning `message-composer.tsx` states for
  // its own identical ref.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) if (a.objectUrl) URL.revokeObjectURL(a.objectUrl)
    },
    [],
  )

  const uploadOne = useCallback(
    (key: string, file: File) => {
      const formData = new FormData()
      formData.set('workspaceId', String(workspaceId))
      formData.set('file', file)
      uploadMediaAction(formData)
        .then((result) => {
          const uploaded = unwrap(result)
          setAttachments((prev) =>
            prev.map((a) => (a.key === key ? { ...a, status: 'done', mediaId: uploaded.id } : a)),
          )
        })
        .catch((error: unknown) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.key === key
                ? { ...a, status: 'error', errorMessage: error instanceof Error ? error.message : 'Upload failed.' }
                : a,
            ),
          )
        })
    },
    [workspaceId],
  )

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return
      setAttachmentError(null)

      const room = MAX_ATTACHMENTS_PER_MESSAGE - attachmentsRef.current.length
      if (room <= 0) {
        setAttachmentError(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`)
        return
      }
      const accepted = list.slice(0, room)
      if (list.length > accepted.length) {
        setAttachmentError(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message — only the first ${accepted.length} were added.`)
      }

      const next: UploadingAttachment[] = []
      for (const file of accepted) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setAttachmentError(`"${file.name}" is over ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB and was not added.`)
          continue
        }
        const key = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
        next.push({
          key,
          file,
          status: 'uploading',
          filesize: file.size,
          mimeType: file.type || 'application/octet-stream',
          objectUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        })
      }
      if (next.length === 0) return
      setAttachments((prev) => [...prev, ...next])
      for (const a of next) uploadOne(a.key, a.file)
    },
    [uploadOne],
  )

  const removeAttachment = useCallback((key: string) => {
    setAttachments((prev) => {
      const found = prev.find((a) => a.key === key)
      if (found?.objectUrl) URL.revokeObjectURL(found.objectUrl)
      return prev.filter((a) => a.key !== key)
    })
  }, [])

  const retryAttachment = useCallback(
    (key: string) => {
      const found = attachmentsRef.current.find((a) => a.key === key)
      if (!found) return
      setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, status: 'uploading', errorMessage: undefined } : a)))
      uploadOne(key, found.file)
    },
    [uploadOne],
  )

  /** Clears the list without revoking-then-forgetting silently — called
   * right after a successful send, mirroring `message-composer.tsx`'s own
   * "clear first" step. */
  const reset = useCallback(() => {
    for (const a of attachmentsRef.current) if (a.objectUrl) URL.revokeObjectURL(a.objectUrl)
    setAttachments([])
    setAttachmentError(null)
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    // Files only — dragging selected text/links within the page must not
    // paint the drop styling or swallow the browser's own drop behaviour.
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer.files.length === 0) return
      e.preventDefault()
      setDragOver(false)
      addFiles(e.dataTransfer.files)
    },
    [addFiles],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((f): f is File => f != null)
      if (files.length === 0) return
      e.preventDefault()
      addFiles(files)
    },
    [addFiles],
  )

  const uploadingCount = attachments.filter((a) => a.status === 'uploading').length
  const doneMediaIds = attachments
    .filter((a): a is UploadingAttachment & { mediaId: number } => a.status === 'done' && a.mediaId != null)
    .map((a) => a.mediaId)

  return {
    attachments,
    attachmentError,
    dragOver,
    uploadingCount,
    doneMediaIds,
    addFiles,
    removeAttachment,
    retryAttachment,
    reset,
    dragHandlers: { onDragOver, onDragLeave, onDrop },
    onPaste,
    MAX_ATTACHMENTS_PER_MESSAGE,
  }
}
