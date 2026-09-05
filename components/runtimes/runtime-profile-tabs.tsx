'use client'

import { useState, type ReactNode } from 'react'
import { Laptop } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface RuntimeProfileTab {
  /** A machine's `hostKey`, or `''` for the "Any machine" (unscoped) group. */
  key: string
  label: string
  count: number
  /** This tab is the machine currently rendering the page. */
  isThisMachine: boolean
}

/**
 * Machines as tabs over the runtime profile list, filtered per tab.
 *
 * All panels are rendered up front and switched with `hidden` rather than
 * mounted/unmounted on click — each row underneath carries its own live
 * state (`RuntimeDefaultsForm`, the probe button's last result), and
 * unmounting a tab would silently discard whatever a person was mid-editing
 * there the moment they looked at another machine.
 *
 * Only rendered by the page when there is more than one tab to switch
 * between — a single machine (or no machines registered yet, everything
 * unscoped) shows the flat list it always has, since a tab strip with one
 * tab in it is not a control, it is decoration.
 */
export function RuntimeProfileTabs({
  tabs,
  defaultTabKey,
  panels,
}: {
  tabs: RuntimeProfileTab[]
  defaultTabKey: string
  panels: Record<string, ReactNode>
}) {
  const [active, setActive] = useState(defaultTabKey)

  return (
    <div>
      <div role="tablist" aria-label="Machines" className="mb-3 flex flex-wrap gap-1 border-b border-black/10 dark:border-white/10">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            onClick={() => setActive(tab.key)}
            className={cn(
              'flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active === tab.key
                ? 'border-foreground text-foreground'
                : 'border-transparent text-faint hover:text-foreground',
            )}
          >
            {tab.key !== '' && <Laptop size={13} />}
            {tab.label}
            {tab.isThisMachine && <span className="text-[10px] font-normal text-faint">(this machine)</span>}
            <span
              className={cn(
                'flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
                active === tab.key ? 'bg-foreground text-background' : 'bg-black/10 text-faint dark:bg-white/15',
              )}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {tabs.map((tab) => (
        <div key={tab.key} hidden={active !== tab.key}>
          {panels[tab.key]}
        </div>
      ))}
    </div>
  )
}
