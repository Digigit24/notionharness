'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { formatRelativeTime } from '@/lib/relative-time'
import type { BlockProvenance, PageProvenanceMap } from '@/lib/provenance'

const HIDE_DELAY_MS = 150

interface HoverTarget {
  blockId: string
  rect: DOMRect
}

/**
 * ROADMAP B-2 — the hover chip's positioning/visibility controller.
 *
 * BlockSuite renders every block as a shadowless custom element carrying
 * its own id as a `data-block-id` attribute — confirmed against
 * `@blocksuite/block-std`'s own event dispatcher, which hit-tests pointer
 * events with `el.closest('[data-block-id]')` (`node_modules/@blocksuite/
 * block-std/dist/event/dispatcher.js`), so this is a real, load-bearing
 * BlockSuite convention, not a guess. This hook reuses that same attribute
 * via one delegated listener pair on the editor's container instead of
 * instrumenting every block individually — there is no way to attach a
 * React event handler into BlockSuite's own Lit tree directly (AGENTS.md's
 * "BlockSuite imports cross an app-wide module boundary" note is about
 * imports, but the same "don't reach into BlockSuite's own DOM/component
 * internals" spirit applies here).
 *
 * Deliberately NOT continuously re-tracking position on scroll/resize —
 * the chip is momentary (shown only while genuinely hovering), so it
 * simply closes on scroll rather than chasing the block's rect; re-hovering
 * reopens it in the right place.
 */
export function useBlockProvenanceHover(containerRef: RefObject<HTMLElement | null>, provenance: PageProvenanceMap) {
  const [hover, setHover] = useState<HoverTarget | null>(null)
  const provenanceRef = useRef(provenance)
  provenanceRef.current = provenance
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  const scheduleHide = () => {
    cancelHide()
    hideTimer.current = setTimeout(() => setHover(null), HIDE_DELAY_MS)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const blockEl = target?.closest<HTMLElement>('[data-block-id]')
      if (!blockEl || !container.contains(blockEl)) return
      const blockId = blockEl.dataset.blockId
      if (!blockId || !provenanceRef.current[blockId]) return
      cancelHide()
      setHover((current) => (current?.blockId === blockId ? current : { blockId, rect: blockEl.getBoundingClientRect() }))
    }

    const handleOut = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const blockEl = target?.closest<HTMLElement>('[data-block-id]')
      if (!blockEl) return
      const related = event.relatedTarget as Node | null
      if (related && blockEl.contains(related)) return // still inside the same block
      scheduleHide()
    }

    const handleScroll = () => setHover(null)

    container.addEventListener('mouseover', handleOver)
    container.addEventListener('mouseout', handleOut)
    // `capture: true` — scroll events don't bubble, so a scrollable
    // ancestor (page-canvas.tsx's own `overflow-y-auto` container) is only
    // observable this way.
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      container.removeEventListener('mouseover', handleOver)
      container.removeEventListener('mouseout', handleOut)
      window.removeEventListener('scroll', handleScroll, true)
      cancelHide()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- provenance is read via provenanceRef so its value doesn't need to retrigger listener setup
  }, [containerRef])

  const info: BlockProvenance | null = hover ? provenanceRef.current[hover.blockId] ?? null : null

  return {
    hoverInfo: info,
    hoverRect: hover?.rect ?? null,
    keepOpen: cancelHide,
    requestClose: scheduleHide,
  }
}

/** The chip itself — rendered into a `document.body` portal (via the
 * hook's caller) so it sits outside BlockSuite's own DOM subtree entirely,
 * both for correct fixed-position stacking and to keep it clear of the
 * cascade-layers gotcha (a portal to `document.body` shares no selector
 * surface with anything BlockSuite's global styles target). */
export function BlockProvenanceChip({
  rect,
  info,
  workspaceSlug,
  onMouseEnter,
  onMouseLeave,
}: {
  rect: DOMRect
  info: BlockProvenance
  workspaceSlug?: string
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  if (typeof document === 'undefined') return null

  const label = [info.agentName ?? 'Unknown agent', `run #${info.runId}`, formatRelativeTime(info.committedAt)].join(' · ')
  const taskSuffix = info.taskTitle ? ` · on ${info.taskTitle}` : ''
  const href = workspaceSlug ? `/workspace/${workspaceSlug}/runs/${info.runId}/review` : null

  // Clamped rather than measured (no live browser to confirm exact chip
  // dimensions this session) — keeps the chip on-screen for the common
  // case without needing a second layout pass.
  const top = Math.min(Math.max(8, rect.top), window.innerHeight - 40)
  const left = Math.min(rect.right + 8, window.innerWidth - 280)

  const body = (
    <span>
      {label}
      {taskSuffix}
    </span>
  )

  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="pointer-events-auto fixed z-50 w-fit max-w-xs rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-lg"
      style={{ top, left }}
    >
      {href ? (
        <Link href={href} className="hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>,
    document.body,
  )
}
