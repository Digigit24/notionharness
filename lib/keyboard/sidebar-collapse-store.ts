'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'

/**
 * Minimal shared state for sidebar collapse, so `<KeyboardProvider>`'s
 * `mod+\` shortcut can toggle it without needing to sit inside a shared
 * React context tree with `<Sidebar>`.
 *
 * Before this, `collapsed` was local `useState` fully owned by
 * `components/sidebar/sidebar.tsx` — nothing outside that component could
 * read or change it. Since B-0's mounting rule keeps `WorkspaceLayout`
 * untouched (a human wires up all four parallel B-0 pieces there to avoid
 * merge conflicts), a React context provider would need to wrap both
 * `<Sidebar>` and `<KeyboardProvider>` from that same layout file — not
 * available to this branch. A plain module-level store sidesteps that:
 * both `Sidebar` and `KeyboardProvider` just import this singleton, however
 * they end up nested. `Sidebar` still owns persistence (reads/writes the
 * `notionforge:sidebar:<slug>` localStorage key exactly as before); this
 * store only holds the live boolean and notifies subscribers.
 */

type Listener = () => void

class SidebarCollapseStore {
  private collapsed = false
  private listeners = new Set<Listener>()

  getSnapshot = (): boolean => this.collapsed

  // SSR always renders expanded; the real value (if collapsed was
  // persisted) is applied client-side, matching the previous local-state
  // behavior exactly so this introduces no new hydration mismatch.
  getServerSnapshot = (): boolean => false

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set = (value: boolean) => {
    if (this.collapsed === value) return
    this.collapsed = value
    this.listeners.forEach((listener) => listener())
  }

  toggle = () => this.set(!this.collapsed)
}

export const sidebarCollapseStore = new SidebarCollapseStore()

export function useSidebarCollapsed() {
  const collapsed = useSyncExternalStore(
    sidebarCollapseStore.subscribe,
    sidebarCollapseStore.getSnapshot,
    sidebarCollapseStore.getServerSnapshot,
  )
  const setCollapsed = useCallback((value: boolean) => sidebarCollapseStore.set(value), [])
  return { collapsed, setCollapsed, toggle: sidebarCollapseStore.toggle }
}

/**
 * ROADMAP B8.1 (Batch B-6 "Finish") — responsive floor. This app's chosen
 * floor is 1280px (Tailwind's `xl` breakpoint, matching the convention
 * already used throughout this codebase and the plan's own casual mention
 * of that width). Below it, the sidebar should default to collapsed rather
 * than eating ~256px of an already-tight viewport.
 *
 * One-directional by design: crossing DOWN into the narrow band forces a
 * collapse; crossing back UP does *not* force an expand. A one-way rule
 * avoids fighting a user who deliberately expanded the sidebar on a narrow
 * screen (e.g. a resized browser window, not just a phone) — auto-expanding
 * out from under them on every resize would be more surprising than useful.
 * `Sidebar` still owns persistence (see its own header comment); this only
 * ever *pushes* `collapsed` to `true`, never reads it back.
 */
const SIDEBAR_AUTO_COLLAPSE_MEDIA_QUERY = '(max-width: 1279px)'

export function useSidebarAutoCollapse(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(SIDEBAR_AUTO_COLLAPSE_MEDIA_QUERY)
    const applyIfNarrow = (matches: boolean) => {
      if (matches) sidebarCollapseStore.set(true)
    }
    applyIfNarrow(mql.matches)
    const listener = (e: MediaQueryListEvent) => applyIfNarrow(e.matches)
    mql.addEventListener('change', listener)
    return () => mql.removeEventListener('change', listener)
  }, [])
}
