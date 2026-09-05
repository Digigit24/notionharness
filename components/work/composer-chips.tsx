'use client'

import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

import type { SessionConfigOption } from '@/lib/runtimes/handshake'

/**
 * Per-message runtime settings, in the composer.
 *
 * Effort and permission mode are properties of the *question*, not of the
 * agent: "answer this one harder" and "let this one edit without asking" are
 * decisions you make while typing, and sending someone to a settings screen to
 * change an agent, ask, and change it back is not a workflow anyone follows.
 *
 * Every chip here comes from the runtime's own `session/new` declaration, so
 * this component knows nothing about any particular CLI and a runtime that
 * adds a setting gets a chip for free. Options with no obvious place in a
 * composer — a model list, say — are left to the agent's settings; the chips
 * show the ones that genuinely change per message.
 */

/** ACP's own categories for the settings worth deciding per message. */
const COMPOSER_CATEGORIES = new Set(['mode', 'thought_level'])

/** Ids used by runtimes that omit the category. */
const COMPOSER_IDS = new Set(['mode', 'effort'])

export function composerOptions(options: SessionConfigOption[] | undefined): SessionConfigOption[] {
  if (!options) return []
  return options.filter(
    (option) =>
      option.type === 'select' &&
      (option.category ? COMPOSER_CATEGORIES.has(option.category) : COMPOSER_IDS.has(option.id)),
  )
}

export function ComposerChips({
  options,
  values,
  onChange,
  disabled,
  isAnswering,
}: {
  options: SessionConfigOption[]
  /** `{ [optionId]: value }` for the next message. */
  values: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled?: boolean
  /**
   * True while THIS session's current turn is still running.
   *
   * This harness spawns one process per turn (see `work-view.tsx`'s own
   * comment on `messageConfig`) — there is no live session to steer mid-turn,
   * so a chip changed here never reaches the answer already in flight. It
   * only takes effect on the NEXT message sent, and only for that one
   * message. Left `undefined` (no notice) by a caller with no such turn to
   * be mid of — the hero composer, which only ever runs before any session
   * exists.
   */
  isAnswering?: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  if (options.length === 0) return null

  // Only worth saying once there is BOTH a turn in flight and an override
  // actually set — changing nothing has nothing to apply "next" that differs
  // from what already happened, and the notice would be true but pointless.
  const hasOverride = Object.keys(values).length > 0

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => {
        const current = values[option.id]
        const selected = (option.options ?? []).find((choice) => choice.value === current)
        // The runtime's own default is a real state, distinct from any value
        // this app might pick on its behalf.
        const shown = selected?.name ?? option.name
        const isOpen = openId === option.id
        return (
          <div key={option.id} className="relative">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setOpenId(isOpen ? null : option.id)}
              title={option.description ?? option.name}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition disabled:opacity-50 ${
                selected
                  ? 'border-transparent bg-black/[0.07] font-medium dark:bg-white/[0.11]'
                  : 'border-black/12 text-black/55 hover:bg-black/[0.03] dark:border-white/15 dark:text-white/55 dark:hover:bg-white/[0.05]'
              }`}
            >
              {shown}
              <ChevronDown size={10} />
            </button>
            {isOpen && (
              <>
                {/* Click-away, so a chip menu never gets stuck open over the
                    composer someone is trying to type in. */}
                <button
                  type="button"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={() => setOpenId(null)}
                  className="fixed inset-0 z-20 cursor-default"
                />
                <div className="absolute bottom-full left-0 z-30 mb-1 min-w-52 overflow-hidden rounded-lg border border-black/10 bg-white py-1 shadow-lg dark:border-white/15 dark:bg-[#232323]">
                  <ChipChoice
                    label={`Agent default${option.currentValue ? ` (${String(option.currentValue)})` : ''}`}
                    active={current === undefined}
                    onSelect={() => {
                      const next = { ...values }
                      delete next[option.id]
                      onChange(next)
                      setOpenId(null)
                    }}
                  />
                  {(option.options ?? []).map((choice) => (
                    <ChipChoice
                      key={choice.value}
                      label={choice.name}
                      description={choice.description ?? undefined}
                      active={current === choice.value}
                      onSelect={() => {
                        onChange({ ...values, [option.id]: choice.value })
                        setOpenId(null)
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )
      })}
      </div>
      {/* Honest, not alarming — a caption beside the chips rather than a
          toast, since it fires on every mid-turn chip change and a popup for
          each would be noise. See this prop's own comment for why the effect
          really is delayed, not a bug. */}
      {isAnswering && hasOverride && (
        <span className="text-[10px] text-black/40 dark:text-white/40">Applies to your next message</span>
      )}
    </div>
  )
}

function ChipChoice({
  label,
  description,
  active,
  onSelect,
}: {
  label: string
  description?: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs transition hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
    >
      <Check size={12} className={active ? 'mt-0.5 shrink-0' : 'mt-0.5 shrink-0 opacity-0'} />
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {description && (
          <span className="block truncate text-[10px] text-black/40 dark:text-white/40">{description}</span>
        )}
      </span>
    </button>
  )
}
