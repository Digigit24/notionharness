'use client'

import { useEffect, useId, useRef } from 'react'
import { keyboardRegistry, normalizeCombo, type ShortcutScope } from './registry'

/**
 * Declaratively registers a keyboard shortcut against the shared
 * `keyboardRegistry` for the lifetime of the calling component, and
 * unregisters it on unmount.
 *
 * @param keys        Combo string, e.g. "mod+/", "mod+\\", "j". Always use
 *                     "mod" for Cmd/Ctrl (see `normalizeCombo`) — never
 *                     "cmd" or "ctrl" directly.
 * @param description Shown in the "⌘/" cheat-sheet dialog, grouped by scope.
 *                     Structured (not baked into JSX) so a button tooltip
 *                     could read the same string later.
 * @param handler      Takes no arguments by design — shortcuts trigger an
 *                     action, they don't need the DOM event. Always reads
 *                     the latest closure (via a ref) without re-registering
 *                     on every render.
 * @param scope        'global' (default) is always live. Any other scope
 *                     only fires while at least one component has this hook
 *                     mounted with that same scope — see registry.ts's
 *                     ref-counted activateScope/deactivateScope.
 */
export function useKeyboardShortcut(
  keys: string,
  description: string,
  handler: () => void,
  scope: ShortcutScope = 'global',
) {
  const id = useId()
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const unregister = keyboardRegistry.register({
      id: `${id}:${keys}`,
      keys: normalizeCombo(keys),
      description,
      scope,
      handler: () => handlerRef.current(),
    })
    if (scope !== 'global') keyboardRegistry.activateScope(scope)

    return () => {
      unregister()
      if (scope !== 'global') keyboardRegistry.deactivateScope(scope)
    }
    // `handler` is intentionally omitted: handlerRef keeps it fresh without
    // tearing down and re-registering the binding (and re-counting the
    // scope) on every render.
  }, [id, keys, description, scope])
}
