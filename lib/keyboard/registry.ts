/**
 * Framework-agnostic keyboard shortcut registry.
 *
 * This module owns no React state and no DOM listeners of its own — it is a
 * plain singleton `Map` of active bindings that any part of the app (React
 * or not) can register against, plus a tiny pub/sub so UI (the cheat sheet
 * dialog) can react when bindings change. `components/keyboard/
 * keyboard-provider.tsx` is the only place that attaches a real `keydown`
 * listener; it normalizes the event into a combo string and calls
 * `keyboardRegistry.dispatch(combo)`.
 *
 * Scope model: every binding declares a `scope` ('global' | 'list' | any
 * custom string). 'global' is always active. Any other scope only matches
 * while at least one consumer has called `activateScope(scope)` without a
 * matching `deactivateScope(scope)` yet — activation is ref-counted, so two
 * mounted consumers of the same scope (e.g. two list views, unlikely but
 * possible) don't deactivate each other's bindings early. This is what lets
 * a list-level `j`/`k` binding stay inert until a list component actually
 * mounts and claims the `'list'` scope, instead of firing globally.
 */

export type ShortcutScope = 'global' | 'list' | (string & {})

export interface ShortcutBinding {
  /** Unique registration id (one hook call site = one id). */
  id: string
  /** Normalized combo string, e.g. "mod+/", "mod+\\", "j". Use `normalizeCombo`. */
  keys: string
  /** Human-readable description shown in the cheat sheet (and, later, tooltips). */
  description: string
  scope: ShortcutScope
  handler: () => void
}

type RegistryListener = () => void

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: 'mod',
  command: 'mod',
  meta: 'mod',
  ctrl: 'mod',
  control: 'mod',
  esc: 'escape',
  spacebar: 'space',
  ' ': 'space',
}

// Canonical ordering modifiers are sorted into before being joined, so
// "shift+mod+n" and "mod+shift+n" normalize to the same combo string.
const MODIFIER_ORDER = ['mod', 'shift', 'alt'] as const
type ModifierToken = (typeof MODIFIER_ORDER)[number]

function normalizeToken(token: string): string {
  const t = token.trim().toLowerCase()
  return MODIFIER_ALIASES[t] ?? t
}

function isModifierToken(token: string): token is ModifierToken {
  return (MODIFIER_ORDER as readonly string[]).includes(token)
}

/**
 * Normalizes a declared combo like "Cmd+/", "ctrl+/", or "mod+/" into a
 * canonical string. `mod` is the platform-agnostic alias for Cmd on macOS /
 * Ctrl elsewhere — always author bindings with `mod`, never `cmd`/`ctrl`
 * directly, so the same declaration works on both platforms.
 */
export function normalizeCombo(keys: string): string {
  const tokens = keys
    .split('+')
    .map(normalizeToken)
    .filter((t) => t.length > 0)
  const modifiers = MODIFIER_ORDER.filter((m) => tokens.includes(m))
  const rest = tokens.filter((t) => !isModifierToken(t))
  return [...modifiers, ...rest].join('+')
}

// Bare modifier keydowns (pressing Shift alone, etc.) never form a combo.
const IGNORED_EVENT_KEYS = new Set(['control', 'meta', 'shift', 'alt', 'os', 'contextmenu'])

/** Builds the same canonical combo string `normalizeCombo` produces, from a live KeyboardEvent. */
export function comboFromEvent(event: KeyboardEvent): string {
  const rawKey = event.key.toLowerCase()
  if (IGNORED_EVENT_KEYS.has(rawKey)) return ''

  const modifiers: string[] = []
  if (event.metaKey || event.ctrlKey) modifiers.push('mod')
  if (event.shiftKey) modifiers.push('shift')
  if (event.altKey) modifiers.push('alt')

  let key = rawKey
  if (key === ' ') key = 'space'
  if (key === 'esc') key = 'escape'

  return [...modifiers, key].join('+')
}

/** Renders a normalized combo for display, e.g. "mod+/" -> "⌘ /" or "Ctrl /". */
export function formatCombo(combo: string, isMac: boolean): string {
  const modLabel = isMac ? '⌘' : 'Ctrl'
  const labels: Record<string, string> = {
    mod: modLabel,
    shift: isMac ? '⇧' : 'Shift',
    alt: isMac ? '⌥' : 'Alt',
    escape: 'Esc',
    space: 'Space',
  }
  return combo
    .split('+')
    .map((token) => labels[token] ?? token.toUpperCase())
    .join(isMac ? '' : '+')
}

class KeyboardRegistry {
  private bindings = new Map<string, ShortcutBinding>()
  private scopeCounts = new Map<ShortcutScope, number>([['global', 1]])
  private listeners = new Set<RegistryListener>()
  // `useSyncExternalStore`'s getSnapshot (client AND server) must return a
  // referentially-stable value between calls when nothing has changed — a
  // fresh `[...map.values()]` array every call makes React think the store
  // changed on every render, which is exactly React's own "getServerSnapshot
  // should be cached to avoid an infinite loop" warning. Cache the snapshot
  // and only rebuild it when a mutation actually invalidates it.
  private bindingsSnapshot: ShortcutBinding[] = []

  /** Registers a binding and returns an unregister function (call it on unmount). */
  register = (binding: ShortcutBinding): (() => void) => {
    this.bindings.set(binding.id, binding)
    this.refreshBindingsSnapshot()
    this.emit()
    return () => this.unregister(binding.id)
  }

  unregister = (id: string) => {
    if (this.bindings.delete(id)) {
      this.refreshBindingsSnapshot()
      this.emit()
    }
  }

  /** Ref-counted: N activations require N deactivations before the scope goes inert. */
  activateScope = (scope: ShortcutScope) => {
    this.scopeCounts.set(scope, (this.scopeCounts.get(scope) ?? 0) + 1)
    this.emit()
  }

  deactivateScope = (scope: ShortcutScope) => {
    if (scope === 'global') return // global is always active, never ref-counted down
    const count = this.scopeCounts.get(scope) ?? 0
    if (count <= 1) this.scopeCounts.delete(scope)
    else this.scopeCounts.set(scope, count - 1)
    this.emit()
  }

  isScopeActive = (scope: ShortcutScope): boolean => {
    return (this.scopeCounts.get(scope) ?? 0) > 0
  }

  /**
   * Dispatches a normalized combo to the most recently registered active
   * binding for it (last-registered-wins when more than one active scope
   * happens to claim the same combo). Returns whether anything handled it,
   * so the caller knows whether to `preventDefault()`.
   */
  dispatch = (combo: string): boolean => {
    let winner: ShortcutBinding | undefined
    for (const binding of this.bindings.values()) {
      if (binding.keys === combo && this.isScopeActive(binding.scope)) winner = binding
    }
    if (!winner) return false
    winner.handler()
    return true
  }

  /** Every currently-registered binding, regardless of whether its scope is active — this is what the cheat sheet lists. Referentially stable across calls until the next mutation (register/unregister/activateScope/deactivateScope) — required by `useSyncExternalStore`. */
  getAllBindings = (): ShortcutBinding[] => {
    return this.bindingsSnapshot
  }

  subscribe = (listener: RegistryListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private refreshBindingsSnapshot() {
    this.bindingsSnapshot = [...this.bindings.values()]
  }

  private emit() {
    this.listeners.forEach((listener) => listener())
  }
}

/** Module-level singleton — one registry per browser tab, shared by every `useKeyboardShortcut` call. */
export const keyboardRegistry = new KeyboardRegistry()

/*
 * Example — list-level scope (B4.1 will wire this into the real task/list
 * board; this is intentionally *not* called anywhere yet):
 *
 *   function TaskListView() {
 *     useKeyboardShortcut('j', 'Next item', () => moveSelection(1), 'list')
 *     useKeyboardShortcut('k', 'Previous item', () => moveSelection(-1), 'list')
 *     useKeyboardShortcut('x', 'Select item', () => toggleSelected(), 'list')
 *     useKeyboardShortcut('e', 'Archive item', () => archiveSelected(), 'list')
 *     useKeyboardShortcut('a', 'Assign item', () => openAssignPicker(), 'list')
 *     ...
 *   }
 *
 * While `TaskListView` is mounted, `keyboardRegistry.activateScope('list')`
 * has been called (once per hook, ref-counted) and `j`/`k`/etc. dispatch to
 * these handlers; anywhere else in the app those same keys are simply
 * unbound, because no active scope claims them.
 */
