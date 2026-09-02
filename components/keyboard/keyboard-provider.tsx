'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPage } from '@/app/(app)/actions'
import { comboFromEvent, keyboardRegistry } from '@/lib/keyboard/registry'
import { useKeyboardShortcut } from '@/lib/keyboard/use-keyboard-shortcut'
import { useSidebarCollapsed } from '@/lib/keyboard/sidebar-collapse-store'
import { KeyboardCheatSheet } from './keyboard-cheat-sheet'

// Keys that are still allowed to fire while focus is inside an editable
// element. Kept intentionally tiny — Escape is the only universally-safe
// one (closing a dialog/menu never conflicts with typing).
const EDITABLE_ALLOWLIST = new Set(['escape'])

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  if (target.closest('[contenteditable="true"]')) return true
  // BlockSuite mounts its editor into this wrapper (see
  // components/canvas/page-canvas.tsx / BlockSuiteEditor.tsx). Its own
  // Lit custom elements (`affine-*`) are shadowless/unscoped, so matching
  // the wrapper class is the stable way to say "anywhere inside the block
  // editor," rather than enumerating every `affine-*` tag name.
  if (target.closest('.blocksuite-editor-root')) return true
  return false
}

export interface KeyboardProviderProps {
  children: ReactNode
  /**
   * Needed only for the `mod+n` "new page" default (see below). Both are
   * plain serializable primitives, so a server component (WorkspaceLayout)
   * can pass them straight through without KeyboardProvider itself needing
   * server-only imports.
   */
  workspaceId?: number
  workspaceSlug?: string
}

/**
 * Mounts a single top-level `keydown` listener and dispatches every
 * registered shortcut through `keyboardRegistry`. Also registers the
 * global shortcuts this batch owns (cheat sheet, sidebar toggle, new page)
 * — everything else (list-level j/k/x/e/a, and ⌘K which belongs to the
 * separate command-bar workstream) is deliberately left unregistered here.
 *
 * Usage: wrap `{children}` in `<KeyboardProvider>` inside `WorkspaceLayout`
 * — see this file's header comment / the batch handoff notes for the exact
 * one-liner.
 */
export function KeyboardProvider({ children, workspaceId, workspaceSlug }: KeyboardProviderProps) {
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false)
  const { toggle: toggleSidebar } = useSidebarCollapsed()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const combo = comboFromEvent(event)
      if (!combo) return
      if (isEditableTarget(event.target) && !EDITABLE_ALLOWLIST.has(combo)) return
      const handled = keyboardRegistry.dispatch(combo)
      if (handled) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useKeyboardShortcut('mod+/', 'Show keyboard shortcuts', () => setCheatSheetOpen((open) => !open), 'global')

  useKeyboardShortcut('mod+\\', 'Toggle sidebar', () => toggleSidebar(), 'global')

  useKeyboardShortcut(
    'mod+n',
    'New page',
    () => {
      // Single global default (see AGENTS.md-adjacent batch notes / final
      // summary for the full rationale): a context-aware "new task" here
      // would need a target status column + board, which this
      // top-of-tree provider has no visibility into, so it isn't attempted.
      // "New page" is the one action that's always well-defined from a
      // bare workspace id/slug, matching the existing NewPageButton /
      // Sidebar "+" affordance exactly (see app/(app)/actions.ts#createPage).
      if (workspaceId === undefined || !workspaceSlug) return
      void createPage({ workspaceId, workspaceSlug, parentPageId: null })
    },
    'global',
  )

  return (
    <>
      {children}
      <KeyboardCheatSheet open={cheatSheetOpen} onOpenChange={setCheatSheetOpen} />
    </>
  )
}
