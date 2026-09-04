'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronRight, Loader2, Terminal, Wrench, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyButton } from './CopyButton'
import { formatDuration } from './format-duration'
import { DiffBlock, looksLikeDiff } from './DiffBlock'

/**
 * A tool call rendered the way a terminal or Claude Desktop shows one:
 * collapsed to a single scannable line by default, expandable to the full
 * input and output on demand.
 *
 * The previous renderer dumped `JSON.stringify(input)` and the raw output as
 * two always-open blocks, which buried the actual answer under machinery —
 * a run that touches a few files pushed its own prose off the screen. A
 * transcript should read as prose with tool work available underneath it,
 * not as a log with prose mixed in.
 */

/** Pulls something human out of a tool's arguments for the collapsed line —
 * the path/command/query if there's an obvious one, otherwise nothing rather
 * than a stringified blob. */
function summarizeInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'cmd', 'path', 'file_path', 'filePath', 'query', 'pattern', 'url']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim())
  return typeof first === 'string' ? first : ''
}

/**
 * Hermes sends the whole invocation as the tool's `title` — `"search: *"`,
 * `"python: story = '''..."` — and leaves ACP's optional `rawInput`
 * unpopulated (verified against real stored events: `input` is `{}` on every
 * tool call). So the argument has to come out of the name, or the card has
 * nothing to show but a bare tool name and an empty `{}` block.
 */
function splitToolTitle(title: string): { name: string; arg: string } {
  const at = title.indexOf(': ')
  if (at === -1) return { name: title, arg: '' }
  return { name: title.slice(0, at), arg: title.slice(at + 2) }
}

/**
 * Unwraps an ACP tool result into readable text. Results arrive as content
 * blocks (`[{ type: 'content', content: { text } }]`), so stringifying them
 * showed a wall of JSON with the actual command output quoted inside it —
 * exactly the thing a person opened the card to read.
 */
function asText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') {
          const inner = (entry as { content?: unknown; text?: unknown }).content ?? entry
          if (typeof inner === 'string') return inner
          if (inner && typeof inner === 'object') {
            const text = (inner as { text?: unknown }).text
            if (typeof text === 'string') return text
          }
          const text = (entry as { text?: unknown }).text
          if (typeof text === 'string') return text
        }
        return ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }

  if (typeof value === 'object') {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
  }

  return JSON.stringify(value, null, 2)
}

// Strips ANSI escapes (colors, cursor moves) so shell output reads as text
// rather than as `[0m[32m` noise. Same approach as TerminalBlock.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g

/** A tool call with no result after this long is reported as possibly hung
 * rather than left saying "waiting" indefinitely. Generous on purpose: real
 * calls (a test suite, a large grep) legitimately run for tens of seconds. */
const TOOL_STALL_MS = 60_000

export function ToolCard({
  toolName,
  toolInput,
  toolOutput,
  isError,
  durationMs,
  toolLocations,
  toolKind,
  startedAt,
  now,
  runEnded = false,
}: {
  toolName: string
  toolInput: Record<string, unknown>
  toolOutput?: unknown
  isError?: boolean
  durationMs?: number
  /** Paths from ACP's own `ToolCall.locations`. With Hermes this is the only
   * place the tool's actual target appears — the title carries just the bare
   * pattern, so a search of a named directory rendered as `COMMAND: *`. */
  toolLocations?: string[]
  /** ACP tool kind (read/edit/search/execute/…), used for the icon. */
  toolKind?: string
  /** When the `tool_call` event arrived — the clock a stall is measured from. */
  startedAt?: string
  /** Coarse wall clock supplied by the Thread. Passed down rather than read
   * here so one timer serves every card on screen instead of one per card. */
  now?: number
  /** The run reached a terminal status. Authoritative: a finished run cannot
   * still be inside a tool call, whatever the events did or didn't say. */
  runEnded?: boolean
}) {
  const [open, setOpen] = useState(false)

  const { name: shortName, arg: titleArg } = splitToolTitle(toolName)
  // Prefer real structured arguments when an agent provides them; fall back
  // to whatever the title carried, which is all Hermes actually sends.
  const summary = summarizeInput(toolInput) || titleArg
  const output = asText(toolOutput).replace(ANSI_PATTERN, '')
  const hasInput = Object.keys(toolInput).length > 0
  // No output yet and no error means the agent is still inside this call.
  const openCall = toolOutput === undefined && !isError
  // ...unless the run has ended, in which case it never completed at all.
  const abandoned = openCall && runEnded
  const pending = openCall && !abandoned
  const elapsedMs = startedAt && now ? now - new Date(startedAt).getTime() : 0
  const stalled = pending && elapsedMs > TOOL_STALL_MS
  // Prefer ACP's own declared kind; fall back to sniffing the display name
  // only when the agent didn't send one.
  const looksLikeShell =
    toolKind === 'execute' || (toolKind == null && /bash|shell|terminal|command|exec|run|python|node/i.test(shortName))
  // The one fact the collapsed line was missing. Shown after the pattern, so
  // "search  *  in celiyo/" reads as a sentence rather than two fragments.
  const locationSummary = toolLocations?.length
    ? toolLocations.length === 1
      ? toolLocations[0]
      : `${toolLocations[0]} +${toolLocations.length - 1} more`
    : ''

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border text-[13px]',
        isError
          ? 'border-red-500/30 bg-red-500/[0.04]'
          : 'border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.03]',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <ChevronRight
          size={13}
          className={cn('shrink-0 text-black/35 transition-transform dark:text-white/35', open && 'rotate-90')}
        />
        {abandoned ? (
          <XCircle size={12} className="shrink-0 text-red-400" />
        ) : stalled ? (
          <AlertTriangle size={12} className="shrink-0 text-amber-500" />
        ) : pending ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-black/40 dark:text-white/40" />
        ) : isError ? (
          <XCircle size={12} className="shrink-0 text-red-500" />
        ) : looksLikeShell ? (
          <Terminal size={12} className="shrink-0 text-black/45 dark:text-white/45" />
        ) : (
          <Wrench size={12} className="shrink-0 text-black/45 dark:text-white/45" />
        )}
        <span className="shrink-0 font-medium text-black/70 dark:text-white/70">{shortName}</span>
        {summary && (
          <span className="min-w-0 shrink truncate font-mono text-[12px] text-black/45 dark:text-white/45">
            {summary}
          </span>
        )}
        {locationSummary && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-black/30 dark:text-white/30"
            title={toolLocations?.join('\n')}
          >
            {locationSummary}
          </span>
        )}
        {!summary && !locationSummary && <span className="flex-1" />}
        {abandoned ? (
          <span className="ml-auto shrink-0 text-[11px] text-red-500/80">never completed</span>
        ) : pending ? (
          <span
            className={cn(
              'ml-auto shrink-0 text-[11px] tabular-nums',
              stalled ? 'text-amber-600 dark:text-amber-400' : 'text-black/35 dark:text-white/35',
            )}
          >
            {stalled ? `no result after ${formatDuration(elapsedMs)}` : 'running…'}
          </span>
        ) : (
          durationMs != null &&
          durationMs > 0 && (
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-black/35 dark:text-white/35">
              {formatDuration(durationMs)}
            </span>
          )
        )}
      </button>

      {open && (
        <div className="border-t border-black/10 dark:border-white/10">
          {/* Only show an input section when there's something in it — an
              empty `{}` block is noise, and Hermes never populates
              `rawInput`, so the argument lives in the title instead. */}
          {hasInput ? (
            <Section label="Input">{JSON.stringify(toolInput, null, 2)}</Section>
          ) : (
            // Label it for what it actually is. Calling a search pattern
            // "Command" was actively misleading — it is the tool's argument,
            // and for Hermes it is all the argument there is.
            summary && <Section label={looksLikeShell ? 'Command' : 'Argument'}>{summary}</Section>
          )}
          {toolLocations && toolLocations.length > 0 && (
            <Section label={toolLocations.length === 1 ? 'Path' : 'Paths'}>{toolLocations.join('\n')}</Section>
          )}
          {toolOutput !== undefined ? (
            // Edit/write tools answer with a unified diff. Rendering that as
            // flat monospace throws away the only thing the reader is
            // actually scanning for — which lines changed and in which
            // direction — so a real diff gets the diff renderer.
            looksLikeDiff(output) ? (
              <div className="px-3 py-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-black/35 dark:text-white/35">
                  {isError ? 'Error' : 'Changes'}
                </div>
                <DiffBlock diff={output} path={summary || undefined} />
              </div>
            ) : (
              <Section label={isError ? 'Error' : 'Output'}>{output}</Section>
            )
          ) : (
            <div
              className={cn(
                'px-3 py-2 text-[12px] italic',
                abandoned
                  ? 'text-red-500/80'
                  : stalled
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-black/35 dark:text-white/35',
              )}
            >
              {abandoned
                ? 'Never completed — the run ended while this call was still open.'
                : stalled
                  ? `No result after ${formatDuration(elapsedMs)} — the tool may have hung.`
                  : pending
                    ? 'Waiting for output…'
                    : 'No output was recorded for this call.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: string }) {
  return (
    <div className="group px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-black/35 dark:text-white/35">
          {label}
        </span>
        {children && <CopyButton value={children} />}
      </div>
      {/* Long output scrolls inside its own box instead of stretching the
          whole conversation — a directory listing shouldn't cost a screen. */}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/[0.04] px-2.5 py-2 font-mono text-[12px] leading-relaxed dark:bg-black/40">
        {children || '—'}
      </pre>
    </div>
  )
}
