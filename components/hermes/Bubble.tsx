'use client'

import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Bubble component for individual content pieces within a message
 * Supports text, code, thinking, tool calls, and tool results
 */
export type BubbleType = 'text' | 'code' | 'thinking' | 'tool-call' | 'tool-result'

export interface BubbleProps {
  type?: BubbleType
  children?: ReactNode
  className?: string
  metadata?: Record<string, unknown>
}

export function Bubble({ type = 'text', children, className, metadata }: BubbleProps) {
  const typeStyles = {
    text: 'bg-transparent',
    code: 'bg-gray-100 dark:bg-gray-800 font-mono text-sm',
    thinking: 'bg-blue-50 dark:bg-blue-900/20 border-l-2 border-blue-500 italic',
    'tool-call':
      'bg-purple-50 dark:bg-purple-900/20 border-l-2 border-purple-500 font-mono text-sm',
    'tool-result':
      'bg-green-50 dark:bg-green-900/20 border-l-2 border-green-500 font-mono text-sm',
  }

  return (
    <div className={cn('p-2', typeStyles[type], className)}>
      {type === 'thinking' && <span className="text-xs text-gray-600 dark:text-gray-400">💭 </span>}
      {type === 'tool-call' && (
        <span className="text-xs text-purple-600 dark:text-purple-400">
          🔧 {metadata?.toolName ? String(metadata.toolName) : ''}:{' '}
        </span>
      )}
      {type === 'tool-result' && (
        <span className="text-xs text-green-600 dark:text-green-400">
          ✓ {metadata?.isError ? '(error)' : ''}{' '}
        </span>
      )}
      <span>{children}</span>
    </div>
  )
}
