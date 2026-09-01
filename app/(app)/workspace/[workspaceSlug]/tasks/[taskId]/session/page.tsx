import { notFound } from 'next/navigation'
import { ThreadFullPage } from '@/components/hermes'
import { getRunMessages, getTaskRuns } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { getPayloadClient } from '@/lib/payload'

export const metadata = {
  title: 'Task Session | NotionForge',
}

interface PageProps {
  params: Promise<{
    workspaceSlug: string
    taskId: string
  }>
}

export default async function SessionPage({ params }: PageProps) {
  const { taskId } = await params
  const taskIdNum = Number(taskId)

  if (isNaN(taskIdNum)) {
    notFound()
  }

  // Fetch the task to verify it exists and get title
  const payload = await getPayloadClient()
  const task = await payload.findByID({
    collection: 'tasks',
    id: taskIdNum,
    depth: 0,
    overrideAccess: true,
  })

  if (!task) {
    notFound()
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
      taskId={taskIdNum}
      taskTitle={task.title}
      agents={agents}
      loader={async (id) => {
        const runs = await getTaskRuns(id)
        return Promise.all(runs.map(async (run) => ({ run, events: await getRunMessages(run.id) })))
      }}
    />
  )
}
