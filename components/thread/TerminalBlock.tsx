'use client'

import { TerminalSquare } from 'lucide-react'

// Strips ANSI escape sequences (colors, cursor movement, etc.) rather than
// interpreting them — the agent's own tool/shell output here is normally
// plain command echo and logs, not a full-screen curses UI, so a dumb strip
// keeps this block dependency-free (no xterm.js) while staying readable.
// True VT100 fidelity (cursor movement, an actually interactive shell) is a
// different feature — see ROADMAP D10's dedicated terminal socket.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Renders one `terminal` RunEvent block (a live agent shell command's
 * output, node-pty-backed — see acp-client.ts) inside a chat bubble.
 * `streaming` shows a blinking cursor — pass it only for the block still
 * actively receiving chunks, not for a completed/historical one.
 *
 * `exited`/`exitCode`/`signal` come from the `terminal_exit` event. A block
 * that simply stopped producing output used to be indistinguishable from one
 * still working; the footer below makes the difference explicit, including
 * the case where the run ended and the shell never reported at all — which is
 * exactly the shape a hung node-pty process has. */
export function TerminalBlock({
  text,
  streaming = false,
  exited = false,
  exitCode,
  signal,
  runEnded = false,
}: {
  text: string
  streaming?: boolean
  exited?: boolean
  exitCode?: number | null
  signal?: string | null
  runEnded?: boolean
}) {
  const clean = stripAnsi(text)
  const killed = exited && signal != null
  const failed = exited && !killed && exitCode != null && exitCode !== 0
  const ok = exited && !killed && exitCode === 0
  // The run is over and no exit ever arrived: state that plainly rather than
  // leaving a block that looks like it is still running.
  const orphaned = !exited && runEnded

  return (
    <div className="overflow-hidden rounded-md border border-black/10 bg-neutral-950 dark:border-white/10">
      <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/5 px-2.5 py-1">
        <TerminalSquare size={12} className="text-white/40" />
        <span className="text-[10px] font-medium uppercase tracking-wide text-white/40">Terminal</span>
        {exited ? (
          <span
            className={
              killed
                ? 'ml-auto text-[10px] font-medium tabular-nums text-amber-400'
                : failed
                  ? 'ml-auto text-[10px] font-medium tabular-nums text-red-400'
                  : 'ml-auto text-[10px] font-medium tabular-nums text-emerald-400'
            }
          >
            {killed ? `killed (${signal})` : `exited ${exitCode ?? 0}`}
          </span>
        ) : orphaned ? (
          <span className="ml-auto text-[10px] font-medium text-amber-400">
            ended without an exit code
          </span>
        ) : (
          ok && null
        )}
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed text-neutral-100">
        {clean}
        {streaming && (
          <span className="ml-0.5 inline-block h-[1em] w-[6px] translate-y-[2px] animate-pulse bg-neutral-100/70 align-middle" />
        )}
      </pre>
    </div>
  )
}
