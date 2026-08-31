'use client'

import { useState } from 'react'
import { PopoverMenu } from '@/components/ui/popover-menu'

const EMOJIS = [
  '📄', '📝', '📌', '📎', '📋', '📅', '🗂️', '📊', '📈', '📁', '💡', '🎯', '🚀', '⭐',
  '🔥', '✅', '📚', '🧠', '🛠️', '🎨', '🧩', '🔍', '💬', '📦', '🌱', '🏠', '🧭', '⚙️',
  '🔔', '❤️',
]

export function EmojiPicker({
  value,
  onSelect,
  onClear,
}: {
  value?: string | null
  onSelect: (emoji: string) => void
  onClear: () => void
}) {
  const [custom, setCustom] = useState('')

  return (
    <PopoverMenu
      trigger={({ toggle }) =>
        value ? (
          <button type="button" onClick={toggle} className="w-fit text-6xl leading-none hover:opacity-80">
            {value}
          </button>
        ) : (
          <button
            type="button"
            onClick={toggle}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-black/50 hover:bg-black/[.06] dark:text-white/50 dark:hover:bg-white/[.08]"
          >
            🙂 Add icon
          </button>
        )
      }
    >
      {(close) => (
        <div className="w-64 p-2">
          <div className="mb-2 flex gap-1">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Paste any emoji..."
              className="min-w-0 flex-1 rounded border border-black/10 bg-transparent px-2 py-1 text-sm outline-none dark:border-white/10"
            />
            <button
              type="button"
              onClick={() => {
                if (custom.trim()) {
                  onSelect(custom.trim())
                  close()
                }
              }}
              className="shrink-0 rounded bg-black/[.06] px-2 text-xs hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            >
              Use
            </button>
          </div>
          <div className="grid grid-cols-8 gap-1">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  onSelect(e)
                  close()
                }}
                className="flex h-7 w-7 items-center justify-center rounded text-lg hover:bg-black/[.06] dark:hover:bg-white/[.08]"
              >
                {e}
              </button>
            ))}
          </div>
          {value && (
            <button
              type="button"
              onClick={() => {
                onClear()
                close()
              }}
              className="mt-2 w-full rounded-md px-2 py-1 text-left text-xs text-black/50 hover:bg-black/[.06] dark:text-white/50 dark:hover:bg-white/[.08]"
            >
              Remove icon
            </button>
          )}
        </div>
      )}
    </PopoverMenu>
  )
}
