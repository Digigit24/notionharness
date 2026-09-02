'use client'

import { useState } from 'react'
import { PopoverMenu } from '@/components/ui/popover-menu'

/**
 * Gallery of preset gradients ("randomizer") plus a paste-a-URL fallback for
 * "upload" until a real media/upload pipeline exists. Values are prefixed so
 * PageCanvas can tell a gradient token apart from an image URL.
 */
export const COVER_GRADIENTS = [
  'gradient:from-orange-200 to-pink-200',
  'gradient:from-blue-200 to-cyan-200',
  'gradient:from-purple-200 to-indigo-200',
  'gradient:from-green-200 to-emerald-200',
  'gradient:from-yellow-200 to-orange-200',
  'gradient:from-rose-200 to-fuchsia-200',
  'gradient:from-slate-300 to-slate-100',
  'gradient:from-teal-200 to-lime-200',
]

export function CoverPicker({ onSelect, trigger }: { onSelect: (value: string) => void; trigger: string }) {
  const [url, setUrl] = useState('')

  return (
    <PopoverMenu
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1.5 rounded-md bg-black/40 px-2 py-1 text-xs text-white hover:bg-black/60"
        >
          {trigger}
        </button>
      )}
    >
      {(close) => (
        <div className="w-72 p-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-black/50 dark:text-white/50">Gallery</span>
            <button
              type="button"
              onClick={() => {
                onSelect(COVER_GRADIENTS[Math.floor(Math.random() * COVER_GRADIENTS.length)])
                close()
              }}
              className="rounded bg-black/[.06] px-2 py-0.5 text-xs hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            >
              Random
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {COVER_GRADIENTS.map((c) => (
              <button
                key={c}
                type="button"
                title="Use this cover"
                onClick={() => {
                  onSelect(c)
                  close()
                }}
                className={`h-10 rounded bg-gradient-to-br ${c.replace('gradient:', '')}`}
              />
            ))}
          </div>
          <div className="mt-2 flex gap-1">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste an image URL..."
              aria-label="Paste an image URL"
              className="min-w-0 flex-1 rounded border border-black/10 bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-white/10"
            />
            <button
              type="button"
              onClick={() => {
                if (url.trim()) {
                  onSelect(url.trim())
                  close()
                }
              }}
              className="shrink-0 rounded bg-black/[.06] px-2 text-xs hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            >
              Use
            </button>
          </div>
        </div>
      )}
    </PopoverMenu>
  )
}
