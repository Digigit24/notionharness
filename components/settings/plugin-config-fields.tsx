'use client'

import type { PluginConfigOption } from '@/app/(app)/workspace/[workspaceSlug]/settings/plugins/actions'

/**
 * R4.5 — one component that renders any plugin's settings form.
 *
 * The point of self-describing configuration is that adding a plugin with
 * settings needs no new screen and no new code. A row says `{ id, label,
 * type, options }` and this draws it; a runtime that later declares its own
 * options through the ACP handshake can be rendered by exactly the same
 * component, which is why the shape is deliberately the small intersection of
 * what both can express rather than anything richer.
 *
 * Three types, on purpose. A form builder that supports everything ends up
 * being a worse version of a real form for every specific case; string,
 * boolean and select cover configuration and stop there.
 */
export function PluginConfigFields({
  options,
  onChange,
  disabled,
}: {
  options: PluginConfigOption[]
  onChange: (next: PluginConfigOption[]) => void
  disabled?: boolean
}) {
  if (options.length === 0) return null

  const update = (id: string, value: unknown) => {
    onChange(options.map((option) => (option.id === id ? { ...option, value } : option)))
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <p className="text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
        Plugin settings
      </p>
      {options.map((option) => {
        const inputId = `plugin-config-${option.id}`
        if (option.type === 'boolean') {
          return (
            <label key={option.id} htmlFor={inputId} className="flex items-center gap-2 text-sm">
              <input
                id={inputId}
                type="checkbox"
                disabled={disabled}
                checked={option.value === true}
                onChange={(event) => update(option.id, event.target.checked)}
                className="size-4"
              />
              <span>{option.label}</span>
            </label>
          )
        }
        if (option.type === 'select') {
          return (
            <label key={option.id} htmlFor={inputId} className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-black/60 dark:text-white/60">{option.label}</span>
              <select
                id={inputId}
                disabled={disabled}
                value={typeof option.value === 'string' ? option.value : ''}
                onChange={(event) => update(option.id, event.target.value)}
                className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
              >
                {/* An unset select is a real state, and silently adopting the
                    first option would write a value nobody chose. */}
                <option value="">Not set</option>
                {(option.options ?? []).map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          )
        }
        return (
          <label key={option.id} htmlFor={inputId} className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-black/60 dark:text-white/60">{option.label}</span>
            <input
              id={inputId}
              type="text"
              disabled={disabled}
              value={typeof option.value === 'string' ? option.value : ''}
              onChange={(event) => update(option.id, event.target.value)}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            />
          </label>
        )
      })}
    </div>
  )
}
