'use client'

// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// A channel: the header, the feed, the composer, and the roster rail
// collapsed to its 36px lane — which is how it renders by default, so the
// skeleton must not reserve the full 15rem panel.
//
// A CLIENT COMPONENT, unlike most `loading.tsx` files in this app, for one
// reason: `useParams()` gives it `teamId` the instant Next.js swaps this in —
// before the channel page's own server component has read anything — and
// `lib/channel-name-cache.ts` already has that channel's name in memory (the
// sidebar wrote it there when it rendered the channel list you just clicked).
// So the header renders the REAL name and icon immediately, and only the
// content below it — the part that actually depends on the server read —
// shows a shimmer. A grey bar where "#general" could already be is a second,
// avoidable layout shift with a shimmer on it.
//
// No breadcrumb row here to match: the live page dropped it (R14 height
// pass) as redundant with this exact header.

import { useParams } from 'next/navigation'
import { Hash } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonFeed } from '@/components/ui/skeletons'
import { getCachedChannelName } from '@/lib/channel-name-cache'

export default function ChannelLoading() {
  const params = useParams<{ teamId: string }>()
  const id = Number(params.teamId)
  const name = Number.isSafeInteger(id) ? getCachedChannelName(id) : null

  return (
    <main className="flex h-full w-full flex-col px-5 py-4">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        {name ? (
          <h1 className="flex items-center gap-1.5 truncate text-xl font-semibold">
            <span aria-hidden className="text-black/25 dark:text-white/25">
              <Hash size={18} />
            </span>
            {name}
          </h1>
        ) : (
          <Skeleton className="h-6 w-40" />
        )}
        <Skeleton className="ml-auto h-7 w-56 rounded-lg" />
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden py-3">
            <SkeletonFeed groups={8} />
          </div>
          <div className="shrink-0 border-t border-black/10 p-3 dark:border-white/10">
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        </div>
        <div className="flex w-9 shrink-0 flex-col items-center gap-1.5 pt-0.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="size-6 rounded" />
          ))}
        </div>
      </div>
    </main>
  )
}
