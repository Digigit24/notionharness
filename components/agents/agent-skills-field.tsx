'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Which skills this agent loads, edited as skills rather than as JSON.
 *
 * WHAT A SKILL ACTUALLY IS HERE, because the field's shape only makes sense
 * once that is stated. `agents.skills` is consumed in exactly one place —
 * `lib/dispatcher/worker.ts` passes it to `buildHermesHomeOverlay` as
 * `enabledSkills`, which normalizes it to a list of NAMES and links one
 * directory per name out of the Hermes install's `skills/` pool into the run's
 * overlay. A name that has no directory is reported as `missingSkills` rather
 * than silently dropped. So the honest editor for this field is a set of names
 * checked against the pool on disk, which is what this is.
 *
 * WHAT IT REPLACES. A `<textarea>` holding `JSON.stringify(agent.skills)`,
 * which failed the whole form on a trailing comma, gave no hint that the
 * strings had to match directories on a machine the browser cannot see, and
 * offered no way to discover what those directories were called. Every skill
 * bound through it was bound by someone who already knew the answer.
 *
 * THE POOL IS FETCHED, NOT ASSUMED. `/api/hermes/skills` proxies the Hermes
 * install, so it can be unavailable — a non-Hermes runtime has no such pool at
 * all. Both cases fall back to free text with the reason on screen, because
 * refusing to edit a stored field because a side channel is down would be
 * worse than editing it carefully.
 */
export function AgentSkillsField({
  value,
  onChange,
  usesHermesHome,
  disabled,
}: {
  /** Raw `agents.skills` — an untyped Payload JSON field, so whatever it holds
   * is normalized rather than trusted. */
  value: unknown
  onChange: (names: string[]) => void
  /** Only a Hermes-home runtime has a skills pool to check names against. */
  usesHermesHome: boolean
  disabled?: boolean
}) {
  const selected = useMemo(() => normalizeSkillNames(value), [value])
  const [pool, setPool] = useState<string[] | null>(null)
  const [poolProblem, setPoolProblem] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!usesHermesHome) {
      setPool(null)
      setPoolProblem(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void fetch('/api/hermes/skills', { cache: 'no-store' })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null)
        if (!response.ok) throw new Error(readError(body) || `Hermes answered ${response.status}`)
        if (!cancelled) {
          setPool(readSkillNames(body))
          setPoolProblem(null)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setPool(null)
        // Named, not swallowed. "No skills listed" and "we could not ask" are
        // different answers and only one of them means the pool is empty.
        setPoolProblem(error instanceof Error ? error.message : 'Could not read the skill pool.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [usesHermesHome])

  const missing = pool ? selected.filter((name) => !pool.includes(name)) : []
  const available = pool ? pool.filter((name) => !selected.includes(name)) : []

  function toggle(name: string) {
    onChange(selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name])
  }

  function addTyped() {
    const name = typed.trim()
    if (!name || selected.includes(name)) {
      setTyped('')
      return
    }
    onChange([...selected, name])
    setTyped('')
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
          Skills ({selected.length})
        </p>
        {loading && <Skeleton className="h-3 w-20" />}
      </div>

      {selected.length === 0 ? (
        <p className="text-[11px] text-black/45 dark:text-white/45">
          This agent loads no skills. It still runs — skills add capability, they are not required.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((name) => (
            <span
              key={name}
              className={
                missing.includes(name)
                  ? 'inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 py-0.5 pl-2 pr-1 text-[11px] text-amber-800 dark:text-amber-300'
                  : 'inline-flex items-center gap-1 rounded-full border border-black/15 bg-black/[.03] py-0.5 pl-2 pr-1 text-[11px] dark:border-white/15 dark:bg-white/[.06]'
              }
            >
              {name}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${name}`}
                onClick={() => toggle(name)}
                className="rounded-full p-0.5 hover:bg-black/10 disabled:opacity-40 dark:hover:bg-white/10"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          <span>
            {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} bound here but {missing.length === 1 ? 'has' : 'have'}{' '}
            no directory in the Hermes skills pool. The run will report {missing.length === 1 ? 'it' : 'them'} as
            missing rather than fail — kept, not silently dropped, in case the pool is simply not installed on this
            machine yet.
          </span>
        </p>
      )}

      {!usesHermesHome ? (
        <p className="text-[11px] text-black/45 dark:text-white/45">
          This agent&apos;s runtime does not use a Hermes home, so there is no skills pool to check these names
          against. They are stored, and whether they mean anything is up to that runtime.
        </p>
      ) : poolProblem ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Could not read the skill pool ({poolProblem}), so names cannot be offered or checked. Type them below if
          you already know them.
        </p>
      ) : available.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-black/10 pt-2 dark:border-white/10">
          {available.map((name) => (
            <button
              key={name}
              type="button"
              disabled={disabled}
              onClick={() => toggle(name)}
              className="rounded-full border border-dashed border-black/20 px-2 py-0.5 text-[11px] text-black/60 hover:border-black/40 hover:text-black disabled:opacity-40 dark:border-white/20 dark:text-white/60 dark:hover:border-white/40 dark:hover:text-white"
            >
              + {name}
            </button>
          ))}
        </div>
      ) : pool && pool.length > 0 ? (
        <p className="text-[11px] text-black/45 dark:text-white/45">Every skill in the pool is bound to this agent.</p>
      ) : (
        !loading && (
          <p className="text-[11px] text-black/45 dark:text-white/45">
            The Hermes install reports no skills. <Badge variant="outline">Empty</Badge> is a real answer here, not a
            failure to load.
          </p>
        )
      )}

      <div className="flex gap-2 border-t border-black/10 pt-2 dark:border-white/10">
        <input
          value={typed}
          disabled={disabled}
          placeholder="Add a skill by name"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            // The field lives inside the settings <form>, so Enter would submit
            // the whole thing and save an agent when somebody meant to add one
            // chip.
            event.preventDefault()
            addTyped()
          }}
          className="min-w-0 flex-1 rounded border border-black/15 px-2 py-1 text-xs dark:border-white/15 dark:bg-white/[.04]"
        />
        <Button type="button" size="sm" variant="outline" disabled={disabled || !typed.trim()} onClick={addTyped}>
          <Plus className="size-3" aria-hidden /> Add
        </Button>
      </div>
    </div>
  )
}

/** The same normalization `lib/runtimes/hermes/home-overlay.ts` applies, for
 * the same reason: the field is untyped JSON and has held both bare strings
 * and `{ name }` objects. The editor must read what is there, not what it
 * wishes were there. */
export function normalizeSkillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) names.push(entry.trim())
    else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      const name = (entry as { name: string }).name.trim()
      if (name) names.push(name)
    }
  }
  return [...new Set(names)]
}

function readSkillNames(body: unknown): string[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as Record<string, unknown>).skills ??
        (body as Record<string, unknown>).items ??
        (body as Record<string, unknown>).data)
      : null
  if (!Array.isArray(rows)) return []
  const names: string[] = []
  for (const row of rows) {
    if (typeof row === 'string') names.push(row)
    else if (row && typeof row === 'object') {
      const record = row as Record<string, unknown>
      const name = [record.name, record.skill, record.id, record.slug].find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
      )
      if (name) names.push(name)
    }
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

function readError(body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error
  }
  return ''
}
