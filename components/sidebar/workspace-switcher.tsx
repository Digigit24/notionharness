'use client'

import Link from 'next/link'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { PopoverMenu } from '@/components/ui/popover-menu'
import type { Workspace } from '@/payload-types'

export function WorkspaceSwitcher({
  workspace,
  workspaces,
}: {
  workspace: Workspace
  workspaces: Workspace[]
}) {
  return (
    <PopoverMenu
      className="min-w-[220px]"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium hover:bg-black/[.06] dark:hover:bg-white/[.08]"
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-black/10 text-xs dark:bg-white/10">
            {workspace.icon || workspace.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate">{workspace.name}</span>
          <ChevronDown size={13} className="shrink-0 text-black/40 dark:text-white/40" />
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col text-sm">
          {workspaces.map((w) => (
            <Link
              key={w.id}
              href={`/workspace/${w.slug}`}
              onClick={close}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-black/[.06] dark:hover:bg-white/[.08]"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-black/10 text-xs dark:bg-white/10">
                {w.icon || w.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="flex-1 truncate">{w.name}</span>
              {w.id === workspace.id && <Check size={14} />}
            </Link>
          ))}
          <Link
            href="/"
            onClick={close}
            className="mt-1 flex items-center gap-2 rounded-md border-t border-black/5 px-2 py-1.5 pt-2 text-black/60 hover:bg-black/[.06] dark:border-white/10 dark:text-white/60 dark:hover:bg-white/[.08]"
          >
            <Plus size={14} />
            New workspace
          </Link>
        </div>
      )}
    </PopoverMenu>
  )
}
