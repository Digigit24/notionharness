import { Activity } from 'lucide-react'
import { ThreadLaneView } from '@/components/thread'
import { getRunMessages, getTaskRuns, getActiveRunsForWorkspace } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { getPayloadClient } from '@/lib/payload'
import { EmptyState } from '@/components/ui/empty-state'

export const metadata = {
  title: 'Active Runs | NotionForge',
}

interface PageProps {
  params: Promise<{
    workspaceSlug: string
  }>
}

export default async function ActiveRunsPage({ params }: PageProps) {
  const { workspaceSlug } = await params

  // Fetch workspace to get its ID
  const payload = await getPayloadClient()
  const workspaceResult = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: workspaceSlug } },
    limit: 1,
    overrideAccess: true,
  })
  const workspace = workspaceResult.docs[0]

  if (!workspace) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-500">Workspace not found.</p>
      </div>
    )
  }

  // Fetch active runs for the workspace
  const activeRuns = await getActiveRunsForWorkspace(workspace.id)
  const taskRuns = activeRuns.filter((run) => run.taskId !== null)

  // Fetch agents.
  //
  // Scoped to this workspace: `overrideAccess: true` bypasses Payload's
  // access control, so an unscoped query returned every agent on the
  // instance and leaked other workspaces' agent names into this picker.
  const agentsResult = await payload.find({
    collection: 'agents',
    where: { workspace: { equals: workspace.id } },
    limit: 100,
    overrideAccess: true,
  })
  const agents = agentsResult.docs

  if (taskRuns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <EmptyState
          icon={<Activity />}
          title="No active runs right now."
          description="Start a run from a task and it'll show up here while it works."
          action={{ label: 'Go to Tasks', href: `/workspace/${workspaceSlug}/tasks` }}
        />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Active Runs</h1>
        <p className="text-gray-500 mt-2">
          Monitoring {taskRuns.length} run{taskRuns.length !== 1 ? 's' : ''} across active tasks
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
        {taskRuns.map((run) => (
          <ThreadLaneView
            key={run.id}
            taskId={run.taskId!}
            agents={agents}
            loader={async (id) => {
              'use server'
              const taskRuns = await getTaskRuns(id)
              return Promise.all(taskRuns.map(async (r) => ({ run: r, events: await getRunMessages(r.id) })))
            }}
            height="h-[500px]"
          />
        ))}
      </div>
    </div>
  )
}
