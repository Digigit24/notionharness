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
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [children, autoScroll])

  return (
    <div
      ref={containerRef}
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
