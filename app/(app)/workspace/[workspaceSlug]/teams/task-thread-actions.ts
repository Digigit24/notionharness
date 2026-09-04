'use server'

// ROADMAP R14-P0.8 — "a task is a thread, and the popup that creates one."
//
// Deliberately a SEPARATE `'use server'` module from this route's own
// `actions.ts` (already large) rather than an addition to it — everything
// here composes THAT file's sibling collections/actions (`createTask`,
// `updateTaskFields`, `createSubtask`, `postChannelMessage`) as a second
// entry point, not a parallel implementation of any of them:
//
//   - The `tasks` row is created via the exact same `createTask`
//     (`../tasks/actions.ts`) the task board and the project detail page's
//     "New task" button already call.
//   - An agent is dispatched by calling `updateTaskFields` with `agent` set
//     — the SAME `enqueueRun` call the board's own agent-assignment flow
//     already makes (see that file's own comment). This module never calls
//     `enqueueRun` itself.
//   - A subtask reuses `createSubtask` (`../tasks/[taskId]/actions.ts`)
//     wholesale — the same `task-links` `parentOf` row the Sub-tasks tab
//     already writes — and only adds the project lock and the thread reply
//     `createSubtask` does not know about.
//
// The one genuinely new piece of state is `tasks.channelThreadRootId`
// (migration `20260905_020000_tasks_channel_thread_root_id`), and the one
// genuinely new write is the `postChannelMessage` call that gives a task its
// thread root (or, for a subtask, its reply under the parent's existing
// root — never a second root; see `createChannelSubtaskAction`).
//
// Access is re-checked here rather than borrowed from `../teams/actions.ts`:
// that file's own `requireAccess` is a private, UNEXPORTED helper on
// purpose — exporting it from a `'use server'` module would turn a plain
// function into a public endpoint (see `../teams/data.ts`'s header comment
// for the exact same reasoning about `loadSlots`). `requireChannelAccess`
// below is the same three checks, built from `../teams/data.ts`'s already-
// safe (non-`'use server'`) exports, so nothing new is made reachable from
// the browser and nothing in `actions.ts` had to change shape.

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { relId } from '@/lib/activity'
import { guard, raise, unwrap, type WithFailure } from '@/lib/failures'
import { postChannelMessage, type ChannelMessage } from '@/lib/broker'
import type { Task } from '@/payload-types'
import { getChannel, isChannelMember, resolveMySlot } from './data'
import { createTask, updateTaskFields } from '../tasks/actions'
import { createSubtask } from '../tasks/[taskId]/actions'

/** The one chip both P0.8.1 (a fresh thread root) and P0.8.2 (opening a
 * task-carrying thread) render — see `components/teams/project-task-chip.tsx`.
 * Built here, server-side, from a `depth: 1` task doc, so the client never
 * has to resolve `status`/`project` itself. */
export interface ProjectTaskChipData {
  taskId: number
  title: string
  statusName: string
  statusCategory: string
  statusColor: string | null
  projectId: number | null
  projectName: string | null
  workspaceSlug: string
}

function chipFromTask(task: Task, workspaceSlug: string): ProjectTaskChipData {
  const status = typeof task.status === 'object' ? task.status : null
  const project = typeof task.project === 'object' ? task.project : null
  return {
    taskId: task.id,
    title: task.title,
    statusName: status?.name ?? 'Unknown',
    statusCategory: status?.category ?? 'backlog',
    statusColor: status?.color ?? null,
    projectId: relId(task.project),
    projectName: project?.name ?? null,
    workspaceSlug,
  }
}

/** The three checks `../teams/actions.ts`'s own private `requireAccess` makes
 * (logged in, workspace member, channel visible), rebuilt from `./data.ts`'s
 * exports rather than importing that function — see this file's header. */
async function requireChannelAccess(workspaceId: number, teamId: number) {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You must be logged in.')

  const payload = await getPayloadClient()
  const workspace = await payload.findByID({
    collection: 'workspaces',
    id: workspaceId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!workspace) raise('not_found', 'That workspace no longer exists.')
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = (workspace.members ?? []).map((m) => (typeof m === 'number' ? m : m.id))
  if (ownerId !== user.id && !memberIds.includes(user.id)) raise('forbidden', 'That workspace is not yours.')

  const team = await getChannel(teamId)
  if (!team) raise('not_found', 'That channel no longer exists.')
  if (team.workspaceId !== workspaceId) raise('forbidden', 'That channel belongs to another workspace.')
  if (team.isPrivate && !(await isChannelMember(teamId, user.id))) {
    raise('not_found', 'That channel no longer exists.')
  }
  return { user, workspaceId }
}

/** The workspace's first task status by board position — the same "resolve
 * server-side rather than ask the caller" choice `createQuickTask`
 * (`../tasks/actions.ts`) already makes, for the same reason: the popup this
 * button opens has no already-loaded status column to pick from either. */
async function firstStatusId(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  workspaceId: number,
): Promise<number> {
  const statuses = await payload.find({
    collection: 'task-statuses',
    where: { workspace: { equals: workspaceId } },
    sort: 'position',
    limit: 1,
    overrideAccess: true,
  })
  const statusId = statuses.docs[0]?.id
  if (!statusId) raise('invalid_input', 'This workspace has no task statuses configured yet.')
  return statusId
}

export interface CreateChannelTaskResult {
  task: Task
  message: ChannelMessage
  chip: ProjectTaskChipData
}

/**
 * R14-P0.8.1 — the "New task" popup's Create button, from either the channel
 * composer or the thread pane's own composer (a thread pane posts its root
 * exactly like the channel does; only the caller differs).
 *
 * Order matters and is NOT a database transaction (Payload's Local API and
 * the broker's raw-pg pool are two separate connections, so there is no
 * single transaction spanning both — the same constraint every other
 * cross-boundary write in this codebase already lives with, e.g.
 * `createTaskFromMessageAction`'s task-then-message-patch in
 * `../teams/actions.ts`): task first, then the message, then the column that
 * links them, so a failure partway through leaves an orphaned task rather
 * than a thread pointing at nothing.
 */
export async function createChannelTaskAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  projectId: number
  agentId?: number | null
  title: string
}): Promise<WithFailure<CreateChannelTaskResult>> {
  return guard(async () => {
    const { user } = await requireChannelAccess(input.workspaceId, input.teamId)
    const title = input.title.trim()
    if (!title) raise('invalid_input', 'Write something first.')

    const payload = await getPayloadClient()
    const statusId = await firstStatusId(payload, input.workspaceId)

    let task = await createTask({
      workspaceId: input.workspaceId,
      workspaceSlug: input.workspaceSlug,
      statusId,
      title,
      createdById: user.id,
      projectId: input.projectId,
    })

    // Dispatch is a SECOND ENTRY POINT into `updateTaskFields`'s existing
    // agent-assignment path, not a second `enqueueRun` call site — see this
    // file's header.
    if (input.agentId != null) {
      task = await updateTaskFields({
        taskId: task.id,
        workspaceSlug: input.workspaceSlug,
        data: { agent: input.agentId },
      })
    }

    const mine = await resolveMySlot(input.teamId, user.id)
    const message = await postChannelMessage({
      teamId: input.teamId,
      fromSlotId: mine?.id ?? null,
      kind: 'status',
      body: `📋 ${title} — opened as a task`,
      threadRootId: null,
    })

    task = await payload.update({
      collection: 'tasks',
      id: task.id,
      data: { channelThreadRootId: message.id },
      overrideAccess: true,
      depth: 1,
      context: { actorId: user.id },
    })

    revalidatePath(`/workspace/${input.workspaceSlug}/teams/${input.teamId}`)
    return { task, message, chip: chipFromTask(task, input.workspaceSlug) }
  })
}

export interface CreateChannelSubtaskResult {
  task: Task
  message: ChannelMessage
  chip: ProjectTaskChipData
}

/**
 * R14-P0.8.3 — "Create subtask" from inside a task-carrying thread. Project
 * is pre-filled and LOCKED to the parent's on the client (the popup does not
 * even show a picker in this mode); this action re-derives it from the
 * parent task server-side rather than trusting whatever the client sent, so
 * a stale/tampered `projectId` cannot detach a subtask from its family.
 */
export async function createChannelSubtaskAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  parentTaskId: number
  agentId?: number | null
  title: string
}): Promise<WithFailure<CreateChannelSubtaskResult>> {
  return guard(async () => {
    const { user } = await requireChannelAccess(input.workspaceId, input.teamId)
    const title = input.title.trim()
    if (!title) raise('invalid_input', 'Write something first.')

    const payload = await getPayloadClient()
    const parent = await payload.findByID({
      collection: 'tasks',
      id: input.parentTaskId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })
    if (!parent || relId(parent.workspace) !== input.workspaceId) {
      raise('not_found', 'That task no longer exists.')
    }
    const rootId = parent.channelThreadRootId
    if (rootId == null) raise('invalid_input', 'That task has no thread to reply into.')

    const statusId = await firstStatusId(payload, input.workspaceId)
    let task = unwrap(
      await createSubtask({
        parentTaskId: input.parentTaskId,
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        statusId,
        title,
      }),
    )

    const parentProjectId = relId(parent.project)
    const patch: Partial<Pick<Task, 'project' | 'agent'>> = {}
    if (parentProjectId != null) patch.project = parentProjectId
    if (input.agentId != null) patch.agent = input.agentId
    if (Object.keys(patch).length > 0) {
      task = await updateTaskFields({ taskId: task.id, workspaceSlug: input.workspaceSlug, data: patch })
    }

    const mine = await resolveMySlot(input.teamId, user.id)
    // A REPLY under the parent's existing root — never a new root. A task's
    // whole family of subtasks lives in one conversation; see this file's
    // header and ROADMAP-SERIES.md's R14-P0.8.3.
    const message = await postChannelMessage({
      teamId: input.teamId,
      fromSlotId: mine?.id ?? null,
      kind: 'status',
      body: `📋 ${title} — opened as a subtask`,
      threadRootId: rootId,
    })

    // The subtask carries the SAME root as its parent, so opening it later
    // (P0.8.2) lands on the shared conversation rather than a thread of its
    // own that nobody would ever find.
    task = await payload.update({
      collection: 'tasks',
      id: task.id,
      data: { channelThreadRootId: rootId },
      overrideAccess: true,
      depth: 1,
      context: { actorId: user.id },
    })

    revalidatePath(`/workspace/${input.workspaceSlug}/teams/${input.teamId}`)
    return { task, message, chip: chipFromTask(task, input.workspaceSlug) }
  })
}

/**
 * Every project task in this workspace that carries a thread, keyed by its
 * root message id — how the room seeds `projectTaskChips` on mount (P0.8.1's
 * chip on the feed row, P0.8.2's chip atop an already-open thread) without
 * this module or `../teams/actions.ts` having to teach `listChannelFeed`/
 * `pollTeamRoomAction` (broker foundation, not edited here) anything about a
 * second, unrelated task system.
 */
export async function listProjectTaskChipsAction(input: {
  workspaceId: number
  workspaceSlug: string
}): Promise<WithFailure<Record<number, ProjectTaskChipData>>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    const payload = await getPayloadClient()
    const workspace = await payload.findByID({
      collection: 'workspaces',
      id: input.workspaceId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })
    if (!workspace) raise('not_found', 'That workspace no longer exists.')
    const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
    const memberIds = (workspace.members ?? []).map((m) => (typeof m === 'number' ? m : m.id))
    if (ownerId !== user.id && !memberIds.includes(user.id)) raise('forbidden', 'That workspace is not yours.')

    const result = await payload.find({
      collection: 'tasks',
      where: {
        workspace: { equals: input.workspaceId },
        channelThreadRootId: { not_equals: null },
      },
      depth: 1,
      limit: 500,
      overrideAccess: true,
    })
    // A subtask (P0.8.3) carries the SAME `channelThreadRootId` as its
    // parent — the whole family shares one thread on purpose — so more than
    // one task can point at a given root. The chip atop that thread must be
    // the ROOT task, never whichever subtask happened to sort last: the
    // parent is always created (and therefore always the lower id) before
    // any subtask can exist, since `createChannelSubtaskAction` requires the
    // parent to already carry a `channelThreadRootId`.
    const byRoot = new Map<number, Task>()
    for (const task of result.docs) {
      if (task.channelThreadRootId == null) continue
      const existing = byRoot.get(task.channelThreadRootId)
      if (!existing || task.id < existing.id) byRoot.set(task.channelThreadRootId, task)
    }
    const out: Record<number, ProjectTaskChipData> = {}
    for (const [rootId, task] of byRoot) out[rootId] = chipFromTask(task, input.workspaceSlug)
    return out
  })
}
