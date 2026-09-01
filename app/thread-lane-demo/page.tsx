import { ThreadLaneView } from '@/components/hermes'
import { getRunMessages, getTaskRuns } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { getPayloadClient } from '@/lib/payload'

export const metadata = {
  title: 'Thread Lane View | NotionForge',
}

/**
 * Demo page showing ThreadLaneView layout in a multi-column team view.
 *
 * This demonstrates one of the three Thread chromes from P5.2.
 * In a real app, this would be one lane in a team/multi-agent board view.
 */
export default async function Page() {
  // For demo: fetch first 4 tasks
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'tasks',
    limit: 4,
    overrideAccess: true,
  })

  const tasks = result.docs
  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-lg text-gray-500">No tasks found. Create tasks to see the thread lane view.</p>
      </div>
    )
  }

  // Fetch agents for display
  const agentsResult = await payload.find({
    collection: 'agents',
    limit: 100,
    overrideAccess: true,
  })
  const agents = agentsResult.docs

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Team Run Threads</h1>
        <p className="text-gray-500 mt-2">Multiple tasks with their latest run threads side-by-side</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {tasks.map((task) => (
          <ThreadLaneView
            key={task.id}
            taskId={task.id}
            taskTitle={task.title}
            agents={agents}
            loader={async (id) => {
              const runs = await getTaskRuns(id)
              return Promise.all(runs.map(async (run) => ({ run, events: await getRunMessages(run.id) })))
            }}
            height="h-[600px]"
          />
        ))}
      </div>
    </div>
  )
}
