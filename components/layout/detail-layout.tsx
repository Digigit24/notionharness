'use client'

/**
 * ROADMAP B-0 "Frame" — the one layout primitive every detail page in the
 * product should use: full-bleed header (breadcrumb, title, status badge,
 * primary action) + URL-backed tabs with counts + a persistent right rail +
 * one content area. See docs/ROADMAP.html's B-0 batch text — this file is
 * "build it once" half of that; the run review page adoption is the "one
 * page uses it" half.
 *
 * Tab state lives in the URL (a `?tab=` search param by default) so every
 * tab is linkable, refresh-safe, and back-button-correct — that's the
 * entire point of building this now instead of leaving every future detail
 * page to reinvent its own ad-hoc tab state. Implemented once, here, so
 * every adopter gets it for free.
 *
 * A parallel B-0 agent is building `components/nav/breadcrumbs.tsx`
 * standalone; at the time this file was written that path didn't exist yet
 * in this worktree (parallel branches, not merged), so the breadcrumb here
 * is a minimal inline render. A human/lead will de-duplicate the two during
 * integration — expected and fine, not a blocker.
 */

import * as React from 'react'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface DetailLayoutBreadcrumbItem {
  label: string
  href?: string
}

export interface DetailLayoutTab {
  /** Stable key — this is the value written to the URL's tab query param. */
  key: string
  label: string
  /** Optional count shown as a small badge next to the tab label. */
  count?: number
  content: React.ReactNode
}

export interface DetailLayoutProps {
  breadcrumb?: DetailLayoutBreadcrumbItem[]
  title: React.ReactNode
  statusBadge?: React.ReactNode
  primaryAction?: React.ReactNode
  tabs: DetailLayoutTab[]
  /** Tab key to select when the URL has no (or an unrecognized) tab param. Defaults to the first tab. */
  defaultTab?: string
  /** Persistent right rail, rendered once outside the tab content — only rendered at all if given. */
  rightRail?: React.ReactNode
  /** Query param name used to persist the active tab. Defaults to "tab". */
  tabParam?: string
  className?: string
}

/**
 * Reads/writes the active tab through `useSearchParams` + `router.push`
 * (`{ scroll: false }`), which needs a Suspense boundary per Next's App
 * Router rules. That boundary is self-contained here so adopters never
 * have to think about it — see `DetailLayoutFallback` below for what
 * renders for the one SSR/hydration tick before the boundary resolves.
 */
export function DetailLayout(props: DetailLayoutProps) {
  return (
    <Suspense fallback={<DetailLayoutFallback {...props} />}>
      <DetailLayoutWithUrlState {...props} />
    </Suspense>
  )
}

function DetailLayoutFallback(props: DetailLayoutProps) {
  const fallbackTab = props.defaultTab ?? props.tabs[0]?.key
  return <DetailLayoutShell {...props} activeTab={fallbackTab} onTabChange={() => {}} />
}

function DetailLayoutWithUrlState(props: DetailLayoutProps) {
  const { tabs, defaultTab, tabParam = 'tab' } = props
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const fallbackTab = defaultTab ?? tabs[0]?.key
  const requestedTab = searchParams.get(tabParam)

  // Local state first, URL second.
  //
  // This used to be `router.push` on every tab click, which is a full App
  // Router navigation: the server component re-runs and the tab only changes
  // once it answers. On a detail page that loads runs, usage and git state,
  // that is a visible stall on a control that should feel like a button —
  // which is what "the tabs lag" was.
  //
  // The tab is now local state, so switching is immediate, and the URL is
  // updated with `history.replaceState` afterwards. That keeps every tab
  // linkable and the back button intact without asking the server for
  // permission to change a highlight (D0: no round trip on a UI action).
  const initialTab = requestedTab && tabs.some((tab) => tab.key === requestedTab) ? requestedTab : fallbackTab
  const [selectedTab, setSelectedTab] = useState<string | undefined>(initialTab)

  // A real navigation (back/forward, or a link into a specific tab) still
  // wins — that is a URL change we did not make, and it should be obeyed.
  useEffect(() => {
    if (requestedTab && tabs.some((tab) => tab.key === requestedTab)) setSelectedTab(requestedTab)
  }, [requestedTab, tabs])

  const activeTab = useMemo(
    () => (selectedTab && tabs.some((tab) => tab.key === selectedTab) ? selectedTab : fallbackTab),
    [selectedTab, tabs, fallbackTab],
  )

  const onTabChange = useCallback(
    (nextKey: string) => {
      setSelectedTab(nextKey)
      // Deliberately not `router.replace`: even a replace re-runs the server
      // component in the App Router. This edits the address bar only.
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search)
        params.set(tabParam, nextKey)
        window.history.replaceState(null, '', `${pathname}?${params.toString()}`)
      }
    },
    [pathname, tabParam],
  )


  return <DetailLayoutShell {...props} activeTab={activeTab} onTabChange={onTabChange} />
}

function DetailLayoutShell({
  breadcrumb,
  title,
  statusBadge,
  primaryAction,
  tabs,
  rightRail,
  activeTab,
  onTabChange,
  className,
}: DetailLayoutProps & { activeTab?: string; onTabChange: (key: string) => void }) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <header className="shrink-0 border-b border-black/10 px-6 py-4 dark:border-white/10">
        {breadcrumb && breadcrumb.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1.5 flex flex-wrap items-center gap-1 text-xs text-black/50 dark:text-white/50">
            {breadcrumb.map((item, idx) => (
              <span key={`${item.label}-${idx}`} className="flex items-center gap-1">
                {idx > 0 && <span className="text-black/30 dark:text-white/30">/</span>}
                {item.href ? (
                  <Link href={item.href} className="hover:text-foreground hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span className="text-foreground">{item.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-lg font-semibold">{title}</h1>
            {statusBadge}
          </div>
          {primaryAction && <div className="flex shrink-0 items-center gap-2">{primaryAction}</div>}
        </div>
      </header>

      {/* ROADMAP B8.1 (Batch B-6 "Finish") — responsive floor. This app's
          chosen floor is 1280px (Tailwind's `xl` breakpoint, matching the
          `lg:`/`xl:` convention already used throughout this codebase).
          Below it the right rail stacks under the tab content instead of
          sitting at a fixed 320px regardless of viewport width; at `xl:`
          and above it returns to the original fixed-width side-by-side
          layout. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-visible">
        <Tabs value={activeTab} onValueChange={onTabChange} className="min-h-0 min-w-0 flex-1 gap-0">
          <TabsList className="mx-6 mt-3 h-auto w-fit gap-0.5 p-1">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.key}
                value={tab.key}
                // Hover feedback was absent, so a tab gave no sign it was a
                // control until it was already selected.
                className="gap-1.5 px-3 py-1 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                {tab.label}
                {typeof tab.count === 'number' && (
                  <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px] leading-none">
                    {tab.count}
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((tab) => (
            <TabsContent key={tab.key} value={tab.key} className="mt-0 flex min-h-0 flex-1 flex-col xl:overflow-auto">
              {tab.content}
            </TabsContent>
          ))}
        </Tabs>

        {rightRail && (
          <aside className="w-full shrink-0 border-t border-black/10 p-4 dark:border-white/10 xl:w-80 xl:overflow-y-auto xl:border-t-0 xl:border-l">
            {rightRail}
          </aside>
        )}
      </div>
    </div>
  )
}
