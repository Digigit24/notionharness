'use client'

import { useMemo, useSyncExternalStore } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCombo, keyboardRegistry, type ShortcutBinding } from '@/lib/keyboard/registry'
import { isMacPlatform } from '@/lib/keyboard/platform'

const SCOPE_LABELS: Record<string, string> = {
  global: 'Global',
  list: 'List',
}

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope.charAt(0).toUpperCase() + scope.slice(1)
}

function useAllBindings(): ShortcutBinding[] {
  return useSyncExternalStore(
    keyboardRegistry.subscribe,
    keyboardRegistry.getAllBindings,
    keyboardRegistry.getAllBindings,
  )
}

/**
 * The primary discoverability surface for every registered shortcut —
 * opened by `mod+/`. Lists whatever is currently registered, grouped by
 * scope, so it stays accurate as more shortcuts are added later without
 * needing its own hardcoded list.
 */
export function KeyboardCheatSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const bindings = useAllBindings()
  const isMac = isMacPlatform()

  const groups = useMemo(() => {
    const byScope = new Map<string, ShortcutBinding[]>()
    for (const binding of bindings) {
      const list = byScope.get(binding.scope) ?? []
      list.push(binding)
      byScope.set(binding.scope, list)
    }
    // Global first, then alphabetical for the rest.
    return [...byScope.entries()].sort(([a], [b]) => {
      if (a === 'global') return -1
      if (b === 'global') return 1
      return a.localeCompare(b)
    })
  }, [bindings])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Currently active shortcuts, grouped by where they apply.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">No shortcuts are registered right now.</p>
          )}
          {groups.map(([scope, scopeBindings]) => (
            <div key={scope} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {scopeLabel(scope)}
              </span>
              <div className="flex flex-col gap-1">
                {scopeBindings.map((binding) => (
                  <div key={binding.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>{binding.description}</span>
                    <kbd className="shrink-0 rounded border border-foreground/10 bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {formatCombo(binding.keys, isMac)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
