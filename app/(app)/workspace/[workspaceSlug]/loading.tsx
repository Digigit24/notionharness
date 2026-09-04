import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'

// ROADMAP B-6 "Finish" (state-craft sweep) — generic segment-level loading
// skeleton. Next.js shows this for the home page (its sibling page.tsx)
// and, absent a more specific loading.tsx in a subdirectory, for any other
// route under this workspace segment during a server-await navigation.
// Shaped like the home page's actual layout (a title, then a run of
// card-bordered sections) rather than a bare spinner, per the plan's
// standard: "skeletons matching final layout, never a spinner on a full
// page." Inbox and Tasks have their own, more specific loading.tsx.
export default function WorkspaceSegmentLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-col gap-8 px-5 py-8">
        <Skeleton className="h-7 w-48" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Card>
              <CardContent className="flex flex-col gap-2 py-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-5/6" />
                <Skeleton className="h-5 w-2/3" />
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  )
}
