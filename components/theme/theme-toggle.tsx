'use client'

import { Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useTheme } from './theme-provider'

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      title={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]',
        className,
      )}
    >
      {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  )
}
