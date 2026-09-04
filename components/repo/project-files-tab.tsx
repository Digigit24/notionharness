'use client'

// R9.4 — the Files tab body on the project detail page.
//
// Why this fetches on mount instead of arriving with data: `ProjectDetailView`
// is a client component, so a tab's `content` cannot be a server component,
// and `page.tsx` for the project route is outside this unit's owned paths so
// a pre-rendered view could not be threaded down as a prop either. The
// mitigation is that the fetch happens when the tab is opened rather than on
// the project page's first render — `DetailLayout` mounts a tab's content
// when it becomes active — so nothing about the project page gets slower, and
// the one call this costs is the same call the directory needed anyway.
//
// The deep-link entry point is the standalone route, which IS server-rendered
// and pays no round trip. The link below is how you get there.
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { RepoBrowser } from './repo-browser'

export function ProjectFilesTab({
  workspaceSlug,
  projectId,
}: {
  workspaceSlug: string
  projectId: number
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex justify-end px-4 pt-3">
        <Link
          href={`/workspace/${workspaceSlug}/projects/${projectId}/files`}
          className="inline-flex items-center gap-1 text-xs text-black/50 hover:text-black dark:text-white/50 dark:hover:text-white"
        >
          Open full browser
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      <RepoBrowser workspaceSlug={workspaceSlug} projectId={projectId} initialView={null} variant="tab" />
    </div>
  )
}
