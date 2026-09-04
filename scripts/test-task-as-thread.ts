// R14-P0.8 — "a task is a thread, and the popup that creates one."
//
// This exercises the exact sequence `createChannelTaskAction` and
// `createChannelSubtaskAction` (`app/(app)/workspace/[workspaceSlug]/teams/
// task-thread-actions.ts`) perform, rather than calling those functions
// themselves: they are Next.js Server Actions, and their access checks
// (`getCurrentPayloadUser` -> `lib/session.ts`'s `getSession` -> `next/
// headers`'s `headers()`) throw "headers() was called outside a request
// scope" when invoked from a bare script with no HTTP request behind it.
// This is not new to this unit — `getCurrentPayloadUser` gates `createTask`/
// `updateTaskFields` in `tasks/actions.ts` the exact same way, which is why
// EVERY existing `scripts/test-*.ts` in this repo (test-teams.ts,
// test-channels.ts) calls straight into `lib/broker/*` and Payload's Local
// API instead of through a page's `'use server'` file, and this script does
// the same for consistency with that established convention.
//
// What IS exercised, against the real database:
//   1. Creating a task-with-project posts a real thread root and sets
//      `channelThreadRootId` to it correctly.
//   2. `channelThreadRootId` round-trips through Payload after being set
//      (a fresh `findByID`, not the value still held in memory).
//   3. Setting an agent on a task and calling `enqueueRun` the same way
//      `updateTaskFields` does creates a real `runs` row against that task —
//      verified by reading the row back, not by waiting on a live agent turn.
//   4. A subtask creates a `task-links` row with `linkType: 'parentOf'`, and
//      posts as a REPLY under the parent's root (`threadRootId` = the
//      parent's root id) rather than opening a second root — and the
//      subtask's own `channelThreadRootId` is set to that SAME shared root,
//      so the family really does live in one conversation.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const teams = await import('../lib/broker/teams')
const ch = await import('../lib/broker/channels')
const { enqueueRun, listRunsForTask } = await import('../lib/broker')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const payload = await getPayloadClient()
const pool = getBrokerPool()

// Same fixture-discovery pattern `test-channels.ts` already uses: find a real
// enabled agent (and the workspace it belongs to) rather than seeding one,
// so this proves the feature against the same rows the app itself would use.
const agentRow = await pool.query<{ id: number; workspace_id: number }>(
  `SELECT id, workspace_id FROM agents WHERE enabled = true ORDER BY id LIMIT 1`,
)
if (agentRow.rows.length === 0) throw new Error('No enabled agent to build a fixture with.')
const { id: agentId, workspace_id: workspaceId } = agentRow.rows[0]

const workspace = await payload.findByID({ collection: 'workspaces', id: workspaceId, depth: 0, overrideAccess: true })
const createdById = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
if (createdById == null) throw new Error('Fixture workspace has no owner to attribute tasks to.')

let statusId = (
  await payload.find({
    collection: 'task-statuses',
    where: { workspace: { equals: workspaceId } },
    sort: 'position',
    limit: 1,
    overrideAccess: true,
  })
).docs[0]?.id
let createdStatusId: number | null = null
if (statusId == null) {
  const status = await payload.create({
    collection: 'task-statuses',
    data: { workspace: workspaceId, name: 'Test Status', category: 'todo', position: 0 },
    overrideAccess: true,
  })
  statusId = status.id
  createdStatusId = status.id
}

let teamId: number | null = null
let projectId: number | null = null
let taskId: number | null = null
let subtaskId: number | null = null
let taskLinkId: number | null = null

try {
  const project = await payload.create({
    collection: 'projects',
    data: { name: `task-as-thread-probe-${Date.now() % 100000}`, workspace: workspaceId },
    overrideAccess: true,
  })
  projectId = project.id

  const team = await teams.createTeam({ workspaceId, name: `task-as-thread-probe-${Date.now() % 100000}` })
  teamId = team.id

  // --- P0.8.1: task, then a NEW thread root, then the link between them ---
  let task = await payload.create({
    collection: 'tasks',
    data: {
      title: 'Ship the parser',
      workspace: workspaceId,
      status: statusId,
      createdBy: createdById,
      project: projectId,
    },
    overrideAccess: true,
  })
  taskId = task.id
  check('a fresh task has no thread yet', task.channelThreadRootId == null, String(task.channelThreadRootId))

  const root = await ch.postChannelMessage({
    teamId: team.id,
    fromSlotId: null,
    kind: 'status',
    body: '📋 Ship the parser — opened as a task',
    threadRootId: null,
  })
  check('the posted message is a ROOT, not a reply', root.threadRootId == null, String(root.threadRootId))

  task = await payload.update({
    collection: 'tasks',
    id: task.id,
    data: { channelThreadRootId: root.id },
    overrideAccess: true,
  })
  check('channelThreadRootId is set to the root it just posted', task.channelThreadRootId === root.id, `${task.channelThreadRootId} vs ${root.id}`)

  // Round-tripped through Payload — a FRESH read, not the value still held
  // from the `update()` call above, which could in principle just echo back
  // whatever was sent without the database having actually stored it.
  const reread = await payload.findByID({ collection: 'tasks', id: task.id, depth: 0, overrideAccess: true })
  check('channelThreadRootId round-trips through a fresh findByID', reread.channelThreadRootId === root.id, String(reread.channelThreadRootId))

  const rootFromBroker = await ch.getChannelMessage(root.id)
  check(
    "the root's own teamId resolves — what a task detail page's \"View thread\" link needs",
    rootFromBroker?.teamId === team.id,
    String(rootFromBroker?.teamId),
  )

  // --- Dispatch: the SAME enqueueRun call updateTaskFields makes when an
  // agent is assigned — see tasks/actions.ts:186. Verified against the real
  // `runs` table rather than a live agent turn, per this repo's own
  // convention for testing dispatch without an ACP round trip.
  task = await payload.update({ collection: 'tasks', id: task.id, data: { agent: agentId }, overrideAccess: true })
  const run = await enqueueRun({ taskId: task.id, agentId, originatorUser: createdById, accountableUser: createdById })
  const runsForTask = await listRunsForTask(task.id)
  check('assigning an agent enqueues a real run against the task', runsForTask.some((r) => r.id === run.id), `${runsForTask.length} run(s)`)
  check('the enqueued run is dispatched against the agent that was picked', run.agentId === agentId, String(run.agentId))

  // --- P0.8.3: a subtask replies under the PARENT's root, never a new one ---
  let subtask = await payload.create({
    collection: 'tasks',
    data: {
      title: 'Write the parser tests',
      workspace: workspaceId,
      status: statusId,
      createdBy: createdById,
      project: projectId,
    },
    overrideAccess: true,
  })
  subtaskId = subtask.id

  const link = await payload.create({
    collection: 'task-links',
    data: { fromTask: task.id, toTask: subtask.id, linkType: 'parentOf' },
    overrideAccess: true,
  })
  taskLinkId = link.id
  check("the task-links row uses the 'parentOf' vocabulary", link.linkType === 'parentOf', String(link.linkType))
  check('fromTask is the parent', (typeof link.fromTask === 'number' ? link.fromTask : link.fromTask.id) === task.id)
  check('toTask is the subtask', (typeof link.toTask === 'number' ? link.toTask : link.toTask.id) === subtask.id)

  const reply = await ch.postChannelMessage({
    teamId: team.id,
    fromSlotId: null,
    kind: 'status',
    body: '📋 Write the parser tests — opened as a subtask',
    threadRootId: task.channelThreadRootId,
  })
  check('the subtask is posted as a REPLY under the parent root', reply.threadRootId === root.id, `${reply.threadRootId} vs ${root.id}`)
  check('and it did NOT open a second root', reply.id !== root.id)

  subtask = await payload.update({
    collection: 'tasks',
    id: subtask.id,
    data: { channelThreadRootId: task.channelThreadRootId },
    overrideAccess: true,
  })
  check(
    "the subtask shares its parent's thread — one conversation for the whole family",
    subtask.channelThreadRootId === task.channelThreadRootId,
    `${subtask.channelThreadRootId} vs ${task.channelThreadRootId}`,
  )

  const thread = await ch.listThread(root.id)
  check('the thread now holds the root plus the subtask reply', thread.length === 2, String(thread.length))
} finally {
  if (taskLinkId != null) await payload.delete({ collection: 'task-links', id: taskLinkId, overrideAccess: true }).catch(() => undefined)
  if (subtaskId != null) await payload.delete({ collection: 'tasks', id: subtaskId, overrideAccess: true }).catch(() => undefined)
  if (taskId != null) await payload.delete({ collection: 'tasks', id: taskId, overrideAccess: true }).catch(() => undefined)
  if (projectId != null) await payload.delete({ collection: 'projects', id: projectId, overrideAccess: true }).catch(() => undefined)
  if (createdStatusId != null) {
    await payload.delete({ collection: 'task-statuses', id: createdStatusId, overrideAccess: true }).catch(() => undefined)
  }
  if (teamId != null) await teams.deleteTeam(teamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
