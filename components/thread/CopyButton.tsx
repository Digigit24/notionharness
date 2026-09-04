'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Copy-to-clipboard affordance. Reveals on hover of its container (give the
 * parent `group`), confirms inline for a beat, then resets.
 *
 * Deliberately dependency-free and state-light: the value most worth copying
 * out of this UI is terminal/tool output, which a user otherwise has to
 * hand-select out of a scrolling box.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // Clipboard can be denied (insecure origin, permissions). Failing
      // quietly is right here — this is a convenience, never the only way
      // to get the text, and an error toast for it would be noise.
    }
  }, [value])

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-black/40 opacity-0 transition',
        'hover:bg-black/[0.06] hover:text-black/70 focus-visible:opacity-100 group-hover:opacity-100',
        'dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/80',
        className,
      )}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? 'Copied' : label}
    </button>
  )
}
