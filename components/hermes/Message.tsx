'use client'

import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Message bubble component for rendering individual messages
 * Supports user, assistant, and system roles with styling variants
 */
export interface MessageProps {
  role: 'user' | 'assistant' | 'system'
  children?: ReactNode
  className?: string
}

export function Message({ role, children, className }: MessageProps) {
  return (
    <div
      className={cn(
        'flex gap-3 mb-4',
        role === 'user' && 'justify-end',
        role === 'assistant' && 'justify-start',
        role === 'system' && 'justify-center',
      )}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2',
          role === 'user' && 'bg-blue-600 text-white',
          role === 'assistant' && 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100',
          role === 'system' && 'text-xs text-gray-500 italic px-2 py-1 bg-transparent',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
