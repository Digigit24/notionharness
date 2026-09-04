import Link from 'next/link'

export interface RuntimeTab {
  id: number
  name: string
  /** Shown under the name so the difference between two tabs is visible
   * without clicking either. */
  hint: string
}

/**
 * One tab per runtime on the Providers page.
 *
 * Links rather than client state, matching the settings rail: each runtime's
 * providers are then linkable, survive a reload, and let the server fetch only
 * what the selected tab actually needs. That last part is the reason this is
 * not a client-side tab switcher — the Hermes tab reads config files off this
 * machine, and doing that to render a Claude tab would be pure waste (D0).
 */
export function RuntimeTabs({
  basePath,
  tabs,
  selectedId,
}: {
  basePath: string
  tabs: RuntimeTab[]
  selectedId: number | null
}) {
  // One runtime is not a choice, and a single tab reads as a broken control.
  if (tabs.length < 2) return null

  return (
    <nav className="mb-5 flex flex-wrap gap-1.5 border-b border-black/10 pb-3 dark:border-white/10">
      {tabs.map((tab) => {
        const active = tab.id === selectedId
        return (
          <Link
            key={tab.id}
            href={`${basePath}?runtime=${tab.id}`}
            className={`rounded-lg px-3 py-1.5 text-left text-xs transition ${
              active
                ? 'bg-black/[0.07] font-medium dark:bg-white/[0.10]'
                : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'
            }`}
          >
            <span className="block">{tab.name}</span>
            <span className="block text-[10px] text-black/40 dark:text-white/40">{tab.hint}</span>
          </Link>
        )
      })}
    </nav>
  )
}
