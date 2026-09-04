'use client'

import type { SessionConfigOption } from '@/lib/runtimes/handshake'

/**
 * The settings a runtime declares about itself, rendered generically.
 *
 * This is the payoff of D2. ACP runtimes describe their own session settings —
 * Claude Code declares `model`, `effort`, `fast` and `mode`, each with a name,
 * a description and its allowed values — so choosing a model needs no
 * Claude-specific screen, no model list we maintain, and no release-chasing
 * when a new model ships. The runtime is asked at probe time and answers for
 * itself.
 *
 * Two option types, because ACP defines exactly two: `select` and `boolean`.
 * Anything else the schema gains later will render as a disabled row saying so
 * rather than silently disappearing, which is the failure mode that matters —
 * a setting that exists but is invisible is worse than one that is visibly
 * unsupported.
 */
export function RuntimeConfigFields({
  options,
  values,
  onChange,
  disabled,
}: {
  options: SessionConfigOption[]
  /** `{ [optionId]: value }`. An id absent here means "use the runtime's own
   * default", which is a real choice and not the same as picking the value
   * that happens to be the default today. */
  values: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled?: boolean
}) {
  if (options.length === 0) return null

  const set = (id: string, value: unknown) => {
    const next = { ...values }
    if (value === '' || value === undefined) delete next[id]
    else next[id] = value
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {options.map((option) => {
        const inputId = `runtime-config-${option.id}`
        const current = values[option.id]

        if (option.type === 'boolean') {
          return (
            <label key={option.id} htmlFor={inputId} className="block text-xs">
              <span className="flex items-center gap-2">
                <input
                  id={inputId}
                  type="checkbox"
                  disabled={disabled}
                  checked={current === true}
                  onChange={(event) => set(option.id, event.target.checked)}
                  className="size-4"
                />
                {option.name}
              </span>
              {option.description && (
                <span className="mt-0.5 block font-normal text-[11px] text-black/45 dark:text-white/45">
                  {option.description}
                </span>
              )}
            </label>
          )
        }

        if (option.type !== 'select') {
          return (
            <p key={option.id} className="text-[11px] text-amber-600 dark:text-amber-400">
              {option.name} uses a setting type this app does not render yet ({option.type}).
            </p>
          )
        }

        return (
          <label key={option.id} htmlFor={inputId} className="block text-xs">
            {option.name}
            <select
              id={inputId}
              disabled={disabled}
              value={typeof current === 'string' ? current : ''}
              onChange={(event) => set(option.id, event.target.value)}
              className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
            >
              {/* Leaving this on "runtime default" is meaningfully different
                  from pinning today's default value: the runtime is free to
                  change its own default, and an agent that said nothing should
                  follow it. */}
              <option value="">
                Runtime default{option.currentValue ? ` (${String(option.currentValue)})` : ''}
              </option>
              {(option.options ?? []).map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.name}
                  {choice.description ? ` — ${choice.description}` : ''}
                </option>
              ))}
            </select>
            {option.description && (
              <span className="mt-0.5 block font-normal text-[11px] text-black/45 dark:text-white/45">
                {option.description}
              </span>
            )}
          </label>
        )
      })}
    </div>
  )
}
