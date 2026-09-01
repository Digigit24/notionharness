import { ThreadLaneView } from '@/components/hermes'
import { getRunMessages, getTaskRuns, getActiveRunsForWorkspace } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { getPayloadClient } from '@/lib/payload'

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
  const workspace = await payload.findOne({
    collection: 'workspaces',
    where: { slug: { equals: workspaceSlug } },
    overrideAccess: true,
  })

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

  // Fetch agents
  const agentsResult = await payload.find({
    collection: 'agents',
    limit: 100,
    overrideAccess: true,
  })
  const agents = agentsResult.docs

  if (taskRuns.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-lg text-gray-500">No active runs at the moment.</p>
          <p className="text-sm text-gray-400 mt-2">Run some agents to see active threads here.</p>
        </div>
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
