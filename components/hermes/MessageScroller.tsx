'use client'

import { useEffect, useRef, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * MessageScroller component
 * Handles anchored scrolling for chat messages, auto-scrolling to latest message
 * Supports custom scroll behavior and preserves scroll position when user scrolls up
 */
export interface MessageScrollerProps {
  children?: ReactNode
  className?: string
  autoScroll?: boolean
}

export function MessageScroller({ children, className, autoScroll = true }: MessageScrollerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!autoScroll || !messagesEndRef.current || !containerRef.current) return

    const container = containerRef.current
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 100

    if (isNearBottom) {
      // ROADMAP B8.2 — respect prefers-reduced-motion: a smooth-scroll
      // animation is exactly the kind of non-essential motion that setting
      // is meant to suppress; jump straight to the new content instead.
      const prefersReducedMotion =
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      messagesEndRef.current.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth' })
    }
  }, [children, autoScroll])

  return (
    <div
      ref={containerRef}
      // ROADMAP B8.2 — this is the one scroller shared by every Thread
      // chrome (drawer/full-page/lane/docked-panel, per D13's "one Thread,
      // N chromes"), so it's the single place that needs to announce
      // streamed agent output to assistive tech. `role="log"` is the
      // standard ARIA role for an appending transcript; `polite` avoids
      // interrupting whatever the user is doing mid-stream.
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      className={cn(
        'flex flex-col gap-4 overflow-y-auto',
        'p-4 bg-white dark:bg-gray-900',
        className,
      )}
    >
      {children}
      <div ref={messagesEndRef} />
    </div>
  )
}
