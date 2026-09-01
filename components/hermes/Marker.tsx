'use client'

import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Marker component for displaying status, activity, or inline indicators
 * Used for typing indicators, errors, loading states, etc.
 */
export type MarkerType = 'loading' | 'error' | 'success' | 'info' | 'warning'

export interface MarkerProps {
  type?: MarkerType
  children?: ReactNode
  className?: string
}

export function Marker({ type = 'info', children, className }: MarkerProps) {
  const typeStyles = {
    loading: 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700',
    error: 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200 border-red-300 dark:border-red-700',
    success:
      'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200 border-green-300 dark:border-green-700',
    info: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-800 dark:text-cyan-200 border-cyan-300 dark:border-cyan-700',
    warning:
      'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700',
  }

  const icons = {
    loading: '⏳',
    error: '❌',
    success: '✅',
    info: 'ℹ️',
    warning: '⚠️',
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border font-medium',
        typeStyles[type],
        className,
      )}
    >
      <span className="text-base">{icons[type]}</span>
      <span>{children}</span>
    </div>
  )
}

/**
 * TypingIndicator component — three animated dots
 */
export function TypingIndicator() {
  return (
    <div className="flex gap-1 py-2">
      <div
        className="w-2 h-2 bg-gray-400 dark:bg-gray-600 rounded-full animate-bounce"
        style={{ animationDelay: '0ms' }}
      />
      <div
        className="w-2 h-2 bg-gray-400 dark:bg-gray-600 rounded-full animate-bounce"
        style={{ animationDelay: '150ms' }}
      />
      <div
        className="w-2 h-2 bg-gray-400 dark:bg-gray-600 rounded-full animate-bounce"
        style={{ animationDelay: '300ms' }}
      />
    </div>
  )
}
