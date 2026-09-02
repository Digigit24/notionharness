import { ThreadFullPage } from '@/components/hermes'
import { getRunMessages, getTaskRuns } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { getPayloadClient } from '@/lib/payload'

export const metadata = {
  title: 'Thread Full Page | NotionForge',
}

/**
 * Demo page showing ThreadFullPage layout with session rail + thread view.
 *
 * This demonstrates one of the three Thread chromes from P5.2.
 * In a real app, this would be mounted as a route in the workspace,
 * with the taskId passed as a route param.
 */
export default async function Page() {
  // For demo: fetch first task from database
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'tasks',
    limit: 1,
    overrideAccess: true,
  })

  const task = result.docs[0]
  if (!task) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-lg text-gray-500">No tasks found. Create a task to see the thread full-page view.</p>
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
    <ThreadFullPage
      taskId={task.id}
      taskTitle={task.title}
      agents={agents}
      loader={async (id) => {
        'use server'
        const runs = await getTaskRuns(id)
        return Promise.all(runs.map(async (run) => ({ run, events: await getRunMessages(run.id) })))
      }}
    />
  )
}
