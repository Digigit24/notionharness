import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { RepoBrowser } from '@/components/repo/repo-browser'
import { failureOf, isFailureEnvelope, type FailureInfo } from '@/lib/failures'
import { readRepoView, type RepoViewPayload } from './actions'

// R9.4 — the standalone repository browser.
//
// The Files TAB on the project detail page is a client component, because
// `ProjectDetailView` is one and a client component cannot host a server
// child. This route exists so the browser also has a server entry point, and
// that is what makes a deep link fast: a URL naming a file renders it
// highlighted in the first response, with no client round trip and no
// spinner. Agents and comments should link here.
//
// It is not a duplicate implementation — both render the same `RepoBrowser`;
// this one hands it a view that was already computed.
export default async function ProjectFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; projectId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspaceSlug, projectId: projectIdParam } = await params
  const projectId = Number(projectIdParam)
  if (!Number.isFinite(projectId)) notFound()

  const query = await searchParams
  const one = (key: string): string | null => {
    const value = query[key]
    return typeof value === 'string' ? value : null
  }
  const resourceParam = Number(one('fres'))

  // Every id here came off the URL. `readRepoView` re-checks all of them
  // against the database (workspace membership, project ownership, resource
  // ownership) before anything touches git, so nothing below is trusted.
  //
  // A project with no repository, a clone that is not on this machine, a path
  // that no longer exists at this ref — all real and all better said than
  // 404'd, because the rest of the browser still works. `readRepoView`
  // RETURNS those rather than throwing, so there is nothing to catch: the
  // failure arrives whole, git's stderr included, and is handed to the
  // browser to render.
  const result = await readRepoView({
    workspaceSlug,
    projectId,
    resourceId: Number.isFinite(resourceParam) && resourceParam > 0 ? resourceParam : null,
    ref: one('fref'),
    path: one('fpath'),
    kind: one('fkind') === 'file' ? 'file' : 'directory',
    worktree: one('fwt') === '1',
  })
  const initialError: FailureInfo | null = failureOf(result)
  const initialView: RepoViewPayload | null = isFailureEnvelope(result) ? null : result

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-black/10 px-6 pt-5 dark:border-white/10">
        <Link
          href={`/workspace/${workspaceSlug}/projects/${projectId}`}
          className="mb-3 inline-flex items-center gap-1 text-xs text-black/50 hover:text-black dark:text-white/50 dark:hover:text-white"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back to project
        </Link>
        <h1 className="pb-4 font-heading text-lg font-semibold">Files</h1>
      </div>
      <RepoBrowser
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        initialView={initialView}
        initialError={initialError}
        variant="page"
      />
    </div>
  )
}
