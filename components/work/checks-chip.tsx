'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { CircleAlert, CircleCheck, CircleSlash, ExternalLink, Loader2, RefreshCw } from 'lucide-react'

import {
  composeFailingChecksPrompt,
  getSessionChecks,
  type SessionChecksState,
} from '@/app/(app)/workspace/[workspaceSlug]/work/checks-actions'

/**
 * R5.6 — a red chip when CI is failing, and one click to hand the failing
 * job's logs to the agent.
 *
 * The click that matters is on the chip itself: pressing a red chip fetches
 * the failed steps with `gh run view --log-failed`, compacts them, and hands
 * the resulting prompt to the composer. That is the whole feature — the
 * moment you notice CI is red you are already in the conversation with the
 * thing that can fix it, and the alternative is a browser tab, a scroll
 * through a log viewer and a copy-paste.
 *
 * **Three states that are not "green".** No `gh`, no GitHub sign-in, no
 * remote, no pull request and no runs, detached HEAD — each renders a
 * disabled chip that says which, because a checkout with no CI is not a
 * passing checkout and colouring it green would be the single most
 * misleading thing this component could do.
 *
 * **Read on demand, never polled.** One mount-time read after paint, and a
 * refresh a person asks for. D0 treats an interval as a design failure unless
 * the thing watched is outside the database — CI genuinely is, but the read
 * spawns `gh` and reaches GitHub, so a timer here would be a network request
 * every few seconds for a chip nobody is looking at. GitHub does push
 * (`check_run` webhooks); this app has no public endpoint to receive one, so
 * on-demand is the honest answer rather than the lazy one.
 */
export function ChecksChip({
  sessionId,
  onHandToAgent,
  className,
}: {
  sessionId: number
  /**
   * Receives the composed prompt. Wire it to the composer's draft state so the
   * text lands in the box the person is about to press Send in.
   *
   * Optional on purpose: without it the chip still works, falling back to
   * showing the prompt with a Copy button. That is a worse experience and it
   * is labelled as such rather than pretending the hand-off happened.
   */
  onHandToAgent?: (prompt: string) => void
  className?: string
}) {
  const [state, setState] = useState<SessionChecksState | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Set only when there is nowhere to hand the prompt to. */
  const [fallbackPrompt, setFallbackPrompt] = useState<string | null>(null)
  const [handing, startHanding] = useTransition()
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    // A stale error from a previous read must not sit under a chip that has
    // since answered fine.
    setError(null)
    try {
      const next = await getSessionChecks(sessionId)
      if (alive.current) setState(next)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : 'Could not read CI status.')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    alive.current = true
    // After paint, never before it: D0 forbids blocking a first render on an
    // external process, and this one shells out to gh and waits on GitHub.
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  const failing = state?.items.filter((item) => item.bucket === 'fail') ?? []
  const pending = state?.counts.pending ?? 0
  const passing = state?.counts.pass ?? 0
  const isRed = failing.length > 0

  function hand() {
    setError(null)
    setNotice(null)
    setFallbackPrompt(null)
    startHanding(async () => {
      try {
        const composed = await composeFailingChecksPrompt(sessionId)
        if (!composed) {
          // The chip was red when it was drawn and the failure has since been
          // re-run green. Say so and re-read rather than handing over nothing.
          setNotice('Nothing is failing any more.')
          await refresh()
          return
        }
        const detail = [
          composed.capped ? 'Logs were cut to fit the message limit — the prompt says where.' : null,
          composed.omittedChecks.length > 0
            ? `Logs for ${composed.omittedChecks.join(', ')} were left out.`
            : null,
          ...composed.unreadable.map((entry) => `${entry.name}: ${entry.reason}`),
        ]
          .filter(Boolean)
          .join(' ')

        if (onHandToAgent) {
          onHandToAgent(composed.prompt)
          setOpen(false)
          setNotice(detail || 'Logs are in the composer — read them, then send.')
        } else {
          setFallbackPrompt(composed.prompt)
          setOpen(true)
          setNotice(detail || null)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read the failing logs.')
        setOpen(true)
      }
    })
  }

  // --- the chip itself -----------------------------------------------------

  let tone = 'border-black/12 text-black/45 dark:border-white/15 dark:text-white/45'
  let icon = <CircleSlash size={11} />
  let label = 'Checks'
  let title = 'GitHub checks for this checkout.'
  let disabled = false

  if (loading && !state) {
    icon = <Loader2 size={11} className="animate-spin" />
    label = 'Checks'
    title = 'Reading CI status…'
    disabled = true
  } else if (!state?.bound) {
    label = 'No checkout'
    title = state?.reason ?? 'This conversation is not bound to a checkout.'
    disabled = true
  } else if (!state.available) {
    label = 'CI unavailable'
    // The reason is the whole value of this state — gh missing, gh signed
    // out, no GitHub remote — so it goes on hover verbatim rather than being
    // flattened into a generic message.
    title = state.reason ?? 'GitHub checks could not be read.'
    disabled = true
  } else if (state.empty) {
    label = 'No checks'
    title = `No pull request and no workflow runs for ${state.branch ?? 'this branch'}. That is not the same as passing.`
    disabled = true
  } else if (isRed) {
    tone = 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
    icon = handing ? <Loader2 size={11} className="animate-spin" /> : <CircleAlert size={11} />
    label = handing ? 'Reading logs…' : `${failing.length} check${failing.length === 1 ? '' : 's'} failing`
    title = 'Hand the failing logs to the agent'
  } else if (pending > 0) {
    tone = 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    icon = <Loader2 size={11} className="animate-spin" />
    label = `${pending} running`
    title = 'CI is still running.'
  } else if (passing > 0) {
    tone = 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    icon = <CircleCheck size={11} />
    label = 'Checks passed'
    title = `All checks passed on ${state.branch ?? 'this branch'}.`
  } else {
    // Everything skipped or cancelled. Neutral, deliberately: a run that was
    // cancelled told us nothing.
    label = 'No verdict'
    title = 'Every check was skipped or cancelled.'
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={disabled || handing}
          title={title}
          // The red chip's own click IS the one click. Any other state has
          // nothing to hand over, so it opens the detail panel instead.
          onClick={() => (isRed ? hand() : setOpen((current) => !current))}
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition disabled:cursor-default disabled:opacity-60 ${tone} ${
            disabled ? '' : 'hover:brightness-105'
          }`}
        >
          {icon}
          {label}
        </button>
        {state?.available && !state.empty && (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            title="Show checks"
            className="rounded px-1 text-[11px] text-black/40 transition hover:bg-black/[0.05] dark:text-white/40 dark:hover:bg-white/[0.07]"
          >
            {open ? '×' : '…'}
          </button>
        )}
      </div>

      {notice && !open && (
        <p className="mt-1 max-w-[22rem] text-[10px] text-black/50 dark:text-white/50">{notice}</p>
      )}
      {error && !open && (
        <p className="mt-1 max-w-[22rem] text-[10px] text-red-600 dark:text-red-400">{error}</p>
      )}

      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 flex w-80 flex-col gap-2 rounded-md border border-black/10 bg-white p-2 shadow-lg dark:border-white/15 dark:bg-neutral-900">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-wide text-black/35 dark:text-white/35">
              {state?.source === 'pull-request' ? 'Pull request checks' : 'Branch workflow runs'}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="Refresh checks"
              className="rounded p-1 text-black/40 transition hover:bg-black/[0.05] dark:text-white/40 dark:hover:bg-white/[0.07]"
            >
              {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            </button>
          </div>

          {error && (
            <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded border border-black/10 px-2 py-1 text-[10px] text-black/60 dark:border-white/15 dark:text-white/60">
              {notice}
            </p>
          )}

          <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            {(state?.items ?? []).map((item) => (
              <li key={`${item.name}:${item.link ?? ''}`} className="flex items-center gap-1.5 text-[11px]">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    item.bucket === 'fail'
                      ? 'bg-red-500'
                      : item.bucket === 'pass'
                        ? 'bg-emerald-500'
                        : item.bucket === 'pending'
                          ? 'bg-amber-500'
                          : 'bg-black/25 dark:bg-white/25'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate" title={`${item.name} — ${item.state ?? item.bucket}`}>
                  {item.name}
                </span>
                {item.link && (
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-black/35 hover:text-black/70 dark:text-white/35 dark:hover:text-white/70"
                    aria-label={`Open ${item.name} on GitHub`}
                  >
                    <ExternalLink size={10} />
                  </a>
                )}
              </li>
            ))}
          </ul>

          {isRed && (
            <button
              type="button"
              disabled={handing}
              onClick={() => hand()}
              className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-700 transition hover:bg-red-500/15 disabled:opacity-60 dark:text-red-300"
            >
              {handing ? 'Reading logs…' : 'Hand the failing logs to the agent'}
            </button>
          )}

          {/* Only reachable when no `onHandToAgent` was wired. Shown rather
              than swallowed: the prompt was built, it just has nowhere to go,
              and saying so beats a button that appears to do nothing. */}
          {fallbackPrompt && (
            <div className="flex flex-col gap-1">
              <p className="text-[10px] text-amber-600 dark:text-amber-400">
                This chip has no composer to write into, so here is the prompt. Copy it into the message box.
              </p>
              <textarea
                readOnly
                value={fallbackPrompt}
                rows={6}
                onFocus={(event) => event.currentTarget.select()}
                className="rounded border border-black/15 bg-transparent p-1 font-mono text-[10px] dark:border-white/15"
              />
              <button
                type="button"
                onClick={() => {
                  // Clipboard access is denied outright in some browser
                  // configurations; the textarea above is the reason this can
                  // fail without losing the text.
                  void navigator.clipboard
                    ?.writeText(fallbackPrompt)
                    .then(() => setNotice('Copied.'))
                    .catch(() => setNotice('Could not reach the clipboard — select the text above instead.'))
                }}
                className="self-start rounded border border-black/15 px-2 py-0.5 text-[10px] dark:border-white/15"
              >
                Copy
              </button>
            </div>
          )}

          {state?.available && failing.some((item) => !item.logsAvailable) && (
            <p className="text-[10px] text-black/45 dark:text-white/45">
              Some failing checks are not GitHub Actions jobs, so gh cannot read their logs. Their links are above.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
