'use client'

import { useEffect, type RefObject } from 'react'
import type { PageProvenanceMap } from '@/lib/provenance'

/**
 * ROADMAP B-2 time filter — "show only what changed this week ... greys
 * everything older" (AGENTS.md's own quote of the plan text). "Everything
 * older" means older *changes*, not old blocks in general: a block with no
 * run provenance (human-authored, or never touched by a run at all) is
 * never greyed here regardless of its age — only a block whose own
 * `committedAt` predates the cutoff gets the reduced-opacity treatment.
 * `staleBeforeMs === null` means "All time" — nothing is greyed.
 *
 * Applies `element.style.opacity` directly rather than a CSS class/rule:
 * per AGENTS.md's cascade-layers gotcha, BlockSuite's own unlayered global
 * `<style>` tags can beat this app's own layered Tailwind utilities on a
 * shared selector — but an inline style always wins regardless of cascade
 * layer, so this sidesteps that failure mode entirely instead of needing a
 * `!important` reclaim rule in `app/globals.css`.
 */
export function useProvenanceGreying(
  containerRef: RefObject<HTMLElement | null>,
  provenance: PageProvenanceMap,
  staleBeforeMs: number | null,
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const apply = () => {
      const blocks = container.querySelectorAll<HTMLElement>('[data-block-id]')
      blocks.forEach((el) => {
        const blockId = el.dataset.blockId
        const entry = blockId ? provenance[blockId] : undefined
        if (!entry || staleBeforeMs === null) {
          el.style.opacity = ''
          return
        }
        const committedAtMs = Date.parse(entry.committedAt)
        el.style.opacity = Number.isFinite(committedAtMs) && committedAtMs < staleBeforeMs ? '0.35' : ''
      })
    }

    apply()

    // BlockSuite streams in new block elements after mount (a live agent
    // run's blocks arriving via BlockSuiteEditor's own live-state poll, or
    // the user's own edits) — re-apply whenever the block tree changes
    // rather than only once at mount.
    const observer = new MutationObserver(apply)
    observer.observe(container, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      // Reset on unmount/dependency-change so a stale inline opacity never
      // lingers past this hook's own lifetime — `apply()` re-runs right
      // after on a dependency change, so this is only ever visible as the
      // final state on a genuine unmount.
      container.querySelectorAll<HTMLElement>('[data-block-id]').forEach((el) => {
        el.style.opacity = ''
      })
    }
  }, [containerRef, provenance, staleBeforeMs])
}
