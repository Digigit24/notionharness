'use client'

import { ReactNode } from 'react'
import { Brain, CheckCircle2, Wrench, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Bubble component for individual content pieces within a message.
 * Supports text, code, thinking, tool calls, and tool results.
 */
export type BubbleType = 'text' | 'code' | 'thinking' | 'tool-call' | 'tool-result'

export interface BubbleProps {
  type?: BubbleType
  children?: ReactNode
  className?: string
  metadata?: Record<string, unknown>
}

export function Bubble({ type = 'text', children, className, metadata }: BubbleProps) {
  const typeStyles: Record<BubbleType, string> = {
    text: 'bg-transparent',
    code: 'rounded-md bg-black/[0.04] font-mono text-[13px] dark:bg-white/[0.06]',
    thinking:
      'rounded-md border border-black/10 bg-black/[0.02] text-[13px] text-black/60 dark:border-white/10 dark:bg-white/[0.03] dark:text-white/50',
    'tool-call':
      'rounded-md border border-black/10 bg-black/[0.02] font-mono text-[12px] dark:border-white/10 dark:bg-white/[0.03]',
    'tool-result':
      'rounded-md border border-emerald-500/20 bg-emerald-500/[0.05] font-mono text-[12px] dark:border-emerald-400/20 dark:bg-emerald-400/[0.06]',
  }

  return (
    <div className={cn('px-3 py-2', typeStyles[type], className)}>
      {type === 'thinking' && (
        <span className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-black/35 dark:text-white/35">
          <Brain size={11} /> Thinking
        </span>
      )}
      {type === 'tool-call' && (
        <span className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-black/50 dark:text-white/50">
          <Wrench size={11} /> {metadata?.toolName ? String(metadata.toolName) : 'Tool call'}
        </span>
      )}
      {type === 'tool-result' && (
        <span
          className={cn(
            'mb-1 flex items-center gap-1.5 text-[11px] font-medium',
            metadata?.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400',
          )}
        >
          {metadata?.isError ? <XCircle size={11} /> : <CheckCircle2 size={11} />}
          {metadata?.isError ? 'Error' : 'Result'}
        </span>
      )}
      <div className={cn(type === 'thinking' && 'italic', 'whitespace-pre-wrap break-words leading-relaxed')}>
        {children}
      </div>
    </div>
  )
}
