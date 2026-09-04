import { redirect } from 'next/navigation'

/**
 * Ask has become Work.
 *
 * Kept as a redirect rather than deleted: bookmarks, the command bar and any
 * link written before the rename all point here, and a 404 for them would
 * read as a regression. Work is the same chat with real, named sessions
 * instead of one implicit per-agent thread — see `components/work/work-view.tsx`.
 */
export default async function AskPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  redirect(`/workspace/${workspaceSlug}/work`)
}
