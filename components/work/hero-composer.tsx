'use client'

import { useRef } from 'react'
import { Bot, FileText, FolderGit2, Loader2, Paperclip, Send, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { SessionConfigOption } from '@/lib/runtimes/handshake'
import type { SessionListItem } from '@/lib/broker'
import { ComposerChips } from './composer-chips'
import { ConnectorsRow } from './connectors-row'
import { QuickActions } from './quick-actions'
import { RecentThreads } from './recent-threads'
import { MarkdownToolbar, useMarkdownActions } from '@/components/composer/markdown-toolbar'
import { useAttachmentUploads } from '@/hooks/use-attachment-uploads'
import type { WorkAgent, WorkProject } from '@/lib/work/types'

/**
 * The Work page's blank/new-session hero — headline, a rounded composer
 * card, quick-action starters, and a compact recent-threads strip.
 *
 * Renders ONLY in place of the old bare "Start a new conversation" text
 * (`work-view.tsx` gates on `activeSessionId == null && !threadToRender`,
 * i.e. exactly the state that used to show that placeholder). The active
 * conversation's own thread + composer are untouched — this component never
 * renders once a session exists.
 *
 * State it needs (agent/project pick, the prompt string, per-message runtime
 * chips) all still lives in `work-view.tsx`, passed down as props, so
 * `handleSend` keeps being the one place a message actually goes out —
 * this component only adds the attachment upload state, which is genuinely
 * local to the composer that collects it.
 */
export function HeroComposer({
  workspaceId,
  workspaceSlug,
  agents,
  projects,
  draftAgentId,
  onDraftAgentChange,
  draftProjectId,
  onDraftProjectChange,
  prompt,
  onPromptChange,
  chipOptions,
  messageConfig,
  onMessageConfigChange,
  sending,
  onSend,
  sessions,
  onSelectSession,
}: {
  workspaceId: number
  workspaceSlug: string
  agents: WorkAgent[]
  projects: WorkProject[]
  draftAgentId: number | null
  onDraftAgentChange: (id: number) => void
  draftProjectId: number | null
  onDraftProjectChange: (id: number | null) => void
  prompt: string
  onPromptChange: (value: string) => void
  chipOptions: SessionConfigOption[]
  messageConfig: Record<string, unknown>
  onMessageConfigChange: (next: Record<string, unknown>) => void
  sending: boolean
  /** Sends the current `prompt`, carrying whichever attachment ids finished
   * uploading by the time Send was pressed. */
  onSend: (attachmentIds: number[]) => void
  sessions: SessionListItem[]
  onSelectSession: (id: number) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const markdown = useMarkdownActions(prompt, onPromptChange, textareaRef)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const {
    attachments,
    attachmentError,
    dragOver,
    uploadingCount,
    doneMediaIds,
    addFiles,
    removeAttachment,
    retryAttachment,
    reset: resetAttachments,
    dragHandlers,
    onPaste,
    MAX_ATTACHMENTS_PER_MESSAGE,
  } = useAttachmentUploads(workspaceId)

  const submitDisabled = sending || uploadingCount > 0 || !prompt.trim()

  function submit() {
    if (submitDisabled) return
    const ids = doneMediaIds
    resetAttachments()
    onSend(ids)
  }

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto px-4 py-10">
      <h1 className="text-center text-4xl font-bold tracking-tight text-black/90 dark:text-white/90">
        Let&apos;s build something.
      </h1>
      <p className="mt-1.5 text-sm text-black/40 dark:text-white/40">
        Pick an agent, say what you need, and watch it work.
      </p>

      <div
        className={cn(
          'relative mt-6 w-full max-w-2xl rounded-2xl border border-black/10 bg-white shadow-sm transition focus-within:border-black/20 focus-within:shadow-md dark:border-white/10 dark:bg-white/[0.03] dark:focus-within:border-white/20',
          dragOver && 'border-blue-400 ring-2 ring-blue-400/30 dark:border-blue-400',
        )}
        {...dragHandlers}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-blue-500/10 text-xs font-medium text-blue-700 backdrop-blur-[1px] dark:text-blue-300">
            Drop to attach
          </div>
        )}

        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
              if (e.key.toLowerCase() === 'b') {
                e.preventDefault()
                markdown.bold()
                return
              }
              if (e.key.toLowerCase() === 'i') {
                e.preventDefault()
                markdown.italic()
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Ask anything or start a task…"
          autoResize
          className="max-h-56 min-h-20 resize-none border-0 bg-transparent px-4 pt-4 pb-1 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          disabled={sending}
        />

        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-1 pt-1">
            {attachments.map((a) => (
              <div
                key={a.key}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs',
                  a.status === 'error'
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-black/10 bg-black/[.02] dark:border-white/10 dark:bg-white/[.04]',
                )}
              >
                {a.objectUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.objectUrl} alt={a.file.name} className="h-9 w-9 shrink-0 rounded object-cover" />
                ) : (
                  <FileText size={16} className="shrink-0 text-black/40 dark:text-white/40" />
                )}
                <div className="min-w-0">
                  <div className="max-w-40 truncate font-medium">{a.file.name}</div>
                  <div className="text-[10px] text-black/40 dark:text-white/40">
                    {a.status === 'uploading' ? 'Uploading…' : a.status === 'error' ? (a.errorMessage ?? 'Upload failed.') : 'Ready'}
                  </div>
                </div>
                {a.status === 'uploading' && (
                  <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" />
                )}
                {a.status === 'error' && (
                  <button
                    type="button"
                    onClick={() => retryAttachment(a.key)}
                    className="shrink-0 text-[10px] font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.key)}
                  className="shrink-0 rounded p-0.5 text-black/30 hover:bg-black/10 hover:text-black/60 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-white/60"
                  aria-label={`Remove ${a.file.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && (
          <p className="flex items-start gap-1.5 px-3 pb-1 text-[11px] text-red-600 dark:text-red-400">
            <TriangleAlert size={12} className="mt-px shrink-0" />
            <span>{attachmentError}</span>
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[.06] px-2.5 py-2 dark:border-white/[.08]">
          <div className="flex items-center gap-0.5">
            <MarkdownToolbar value={prompt} setValue={onPromptChange} textareaRef={textareaRef} disabled={sending}>
              <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" aria-hidden />
              <button
                type="button"
                title="Attach a file"
                aria-label="Attach a file"
                disabled={sending || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                className="flex size-6 items-center justify-center rounded text-black/45 hover:bg-black/[.06] hover:text-black/80 disabled:pointer-events-none disabled:opacity-40 dark:text-white/45 dark:hover:bg-white/[.08] dark:hover:text-white/80"
              >
                <Paperclip size={14} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </MarkdownToolbar>
            <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" aria-hidden />
            <Select value={draftAgentId != null ? String(draftAgentId) : undefined} onValueChange={(v) => onDraftAgentChange(Number(v))}>
              <SelectTrigger size="sm" className="h-7 w-auto rounded-full border-black/10 bg-black/[.02] px-2.5 text-xs dark:border-white/15 dark:bg-white/[.04]">
                <Bot size={12} />
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={draftProjectId != null ? String(draftProjectId) : 'none'}
              onValueChange={(v) => onDraftProjectChange(v === 'none' ? null : Number(v))}
            >
              <SelectTrigger size="sm" className="h-7 w-auto rounded-full border-black/10 bg-black/[.02] px-2.5 text-xs dark:border-white/15 dark:bg-white/[.04]">
                <FolderGit2 size={12} />
                <SelectValue placeholder="No project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No project</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1.5">
            {chipOptions.length > 0 && (
              <ComposerChips options={chipOptions} values={messageConfig} disabled={sending} onChange={onMessageConfigChange} />
            )}
            <Button size="sm" className="rounded-full" onClick={submit} disabled={submitDisabled}>
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Send
            </Button>
          </div>
        </div>

        <ConnectorsRow workspaceSlug={workspaceSlug} />
      </div>

      <QuickActions onPick={(text) => onPromptChange(prompt ? `${prompt}${text}` : text)} />

      <RecentThreads sessions={sessions} onSelect={onSelectSession} />
    </div>
  )
}
