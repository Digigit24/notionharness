'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * R12-P3.4 — a pane you can drag, and a divider that is a line rather than a
 * gutter.
 *
 * WHY A HOOK PLUS A LINE, AND NOT A RESIZABLE-PANEL LIBRARY. The panes here
 * are already laid out by their own screens; all that is missing is a width
 * that a person controls. A library would take ownership of the layout to
 * give back the one number we actually want.
 *
 * WHY THE DRAG DOES NOT GO THROUGH REACT STATE. Setting state on every
 * pointermove re-renders the pane — and in the channel that pane contains a
 * message list — sixty times a second. During a drag this writes the width
 * straight onto the element's own style, which the compositor handles without
 * React knowing, and commits to state exactly once on pointerup. That is the
 * difference between a divider that glides and one that stutters while you
 * hold it.
 *
 * WHY POINTER CAPTURE RATHER THAN WINDOW LISTENERS. `setPointerCapture` keeps
 * every subsequent move and the release addressed to the divider even when
 * the cursor leaves it — which it will, because dragging fast outruns a 1px
 * target. Window listeners are the usual approach and they leak: a pointerup
 * that happens over an iframe, another window, or a disabled tab never
 * arrives, and the pane stays stuck to the cursor forever.
 */
export interface ResizablePaneOptions {
  /** Where the width is remembered, per browser. A layout preference must
   * never cost a request to read (D0), and it is read during hydration where
   * a round trip would be a visible reflow. */
  storageKey: string
  defaultWidth: number
  min?: number
  max?: number
  /**
   * Which edge the divider sits on. `'left'` means the pane is to the RIGHT
   * of its divider (a thread pane docked right), so dragging left widens it.
   */
  edge?: 'left' | 'right'
}

export interface ResizablePane {
  /** Put this on the pane: `style={{ width }}`. */
  width: number
  /** Ref for the pane element, so a drag can write its width directly. */
  paneRef: React.RefObject<HTMLElement | null>
  dividerProps: {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
    onDoubleClick: () => void
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
    'aria-valuenow': number
    'aria-valuemin': number
    'aria-valuemax': number
  }
  dragging: boolean
  reset: () => void
}

export function useResizablePane({
  storageKey,
  defaultWidth,
  min = 260,
  max = 900,
  edge = 'left',
}: ResizablePaneOptions): ResizablePane {
  const [width, setWidth] = useState(defaultWidth)
  const [dragging, setDragging] = useState(false)
  const paneRef = useRef<HTMLElement | null>(null)
  // Read in an effect rather than in the initial state: the server renders the
  // default, and a `useState` initialiser that read storage would hydrate to a
  // different number than the server sent.
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey))
      if (Number.isFinite(stored) && stored >= min && stored <= max) setWidth(stored)
    } catch {
      // Storage blocked. The default is a correct answer.
    }
  }, [storageKey, min, max])

  const persist = useCallback(
    (next: number) => {
      setWidth(next)
      try {
        window.localStorage.setItem(storageKey, String(Math.round(next)))
      } catch {
        // Remembering is a nicety; resizing must work either way.
      }
    },
    [storageKey],
  )

  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button only, and never on a modified click — a right-drag or a
      // ctrl-drag belongs to the browser.
      if (event.button !== 0 || event.ctrlKey || event.metaKey) return
      const divider = event.currentTarget
      const pane = paneRef.current
      if (!pane) return

      event.preventDefault()
      divider.setPointerCapture(event.pointerId)
      setDragging(true)

      const startX = event.clientX
      const startWidth = pane.getBoundingClientRect().width
      let latest = startWidth

      const onMove = (move: PointerEvent) => {
        const delta = edge === 'left' ? startX - move.clientX : move.clientX - startX
        latest = clamp(startWidth + delta)
        // Straight to the DOM. React is told once, below.
        pane.style.width = `${latest}px`
      }

      const finish = () => {
        divider.removeEventListener('pointermove', onMove)
        divider.removeEventListener('pointerup', finish)
        divider.removeEventListener('pointercancel', finish)
        try {
          divider.releasePointerCapture(event.pointerId)
        } catch {
          // Already released — the capture was lost with the element.
        }
        setDragging(false)
        persist(latest)
      }

      divider.addEventListener('pointermove', onMove)
      divider.addEventListener('pointerup', finish)
      // A cancel (the OS taking the pointer, a touch turning into a scroll)
      // must commit too, or the pane keeps whatever width the last move wrote
      // while React still believes the old one.
      divider.addEventListener('pointercancel', finish)
    },
    [clamp, edge, persist],
  )

  const reset = useCallback(() => {
    if (paneRef.current) paneRef.current.style.width = ''
    persist(defaultWidth)
  }, [defaultWidth, persist])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Arrow keys move it, so the divider is not a mouse-only control. The
      // step is deliberately large enough to be useful and small enough to be
      // precise; Shift makes it coarse.
      const step = event.shiftKey ? 64 : 16
      const widen = edge === 'left' ? 'ArrowLeft' : 'ArrowRight'
      const narrow = edge === 'left' ? 'ArrowRight' : 'ArrowLeft'
      if (event.key === widen) {
        event.preventDefault()
        persist(clamp(width + step))
      } else if (event.key === narrow) {
        event.preventDefault()
        persist(clamp(width - step))
      } else if (event.key === 'Home') {
        event.preventDefault()
        reset()
      }
    },
    [clamp, edge, persist, reset, width],
  )

  return {
    width,
    paneRef,
    dragging,
    reset,
    dividerProps: {
      onPointerDown,
      onDoubleClick: reset,
      onKeyDown,
      'aria-valuenow': Math.round(width),
      'aria-valuemin': min,
      'aria-valuemax': max,
    },
  }
}

/**
 * The divider itself: one hairline, no gutter.
 *
 * The visible rule is 1px. The GRAB AREA is 9px, centred on it and
 * transparent, because a 1px hit target is a target people miss — this is the
 * standard trick and it is the reason the two panes can sit flush against
 * each other with no margin between them and still be draggable.
 */
export function PaneDivider({
  className,
  dragging,
  label,
  ...props
}: {
  className?: string
  dragging?: boolean
  label: string
} & ResizablePane['dividerProps']) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      className={cn(
        'group relative z-10 -mx-[4px] w-[9px] shrink-0 cursor-col-resize touch-none select-none',
        'focus-visible:outline-none',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors',
          dragging
            ? 'bg-indigo-500'
            : 'bg-black/10 group-hover:bg-indigo-500/60 group-focus-visible:bg-indigo-500 dark:bg-white/10',
        )}
      />
    </div>
  )
}
