'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import {
  appendRunEvent,
  createSession,
  deleteSession,
  enqueueRun,
  getChatSession,
  getWorktree,
  listRunsForSession,
  listWorktreesForProject,
  listSessions,
  touchSession,
  updateSession,
  type ChatSession,
  type Run,
  type RunMessageRow,
  type SessionListItem,
} from '@/lib/broker'
import { listRunEventsForRuns } from '@/lib/broker/messages'
import { requestRunCancel } from '@/lib/dispatcher/worker'
import { appendMessageToPage } from '@/lib/transcript/to-page'
import type { ChatContent } from '@/lib/hermes/runEvent-adapter'
import { formatAttachmentsForPrompt } from '@/lib/work/attachment-prompt'

/**
 * Server actions for the Work view — the successor to Ask.
 *
 * The important difference from `ask/actions.ts` is what a "conversation" is.
 * Ask had none: it grouped every standalone run for an agent into one
 * forever-thread and faked continuity by prepending the last three exchanges'
 * text to each prompt, which nested on itself (a four-message chat was
 * observed sending a 214,000-token first request). Here a session is a real
 * row, runs point at it, and continuity is Hermes's own — the dispatcher
 * shards `state.db` per session and records the ACP session id on it — so
 * NOTHING is replayed into the prompt. What the user types is what the agent
 * receives.
 */

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return user
}

/** Guards every session action: a session must belong to the workspace the
 * caller is acting in, or ids from one workspace could address another's. */
async function requireSession(sessionId: number, workspaceId: number): Promise<ChatSession> {
  const session = await getChatSession(sessionId)
  if (!session) throw new Error('That conversation no longer exists.')
  if (session.workspaceId !== workspaceId) throw new Error('That conversation belongs to another workspace.')
  return session
}

export async function listWorkSessions(input: {
  workspaceId: number
  agentId?: number | null
  projectId?: number | null
  includeArchived?: boolean
}): Promise<SessionListItem[]> {
  await requireUser()
  return listSessions(input)
}

export async function createWorkSession(input: {
  workspaceId: number
  agentId: number
  projectId?: number | null
  title?: string
}): Promise<ChatSession> {
  const user = await requireUser()
  const payload = await getPayloadClient()
  const agent = await payload
    .findByID({ collection: 'agents', id: input.agentId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!agent || agent.enabled === false) throw new Error('Agent not found or disabled.')
  const agentWorkspaceId = typeof agent.workspace === 'number' ? agent.workspace : agent.workspace?.id
  if (agentWorkspaceId !== input.workspaceId) throw new Error('That agent does not belong to this workspace.')

  return createSession({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    projectId: input.projectId ?? null,
    title: input.title ?? '',
    createdBy: user.id,
  })
}

/** A session's whole thread: every run, with its events, oldest first. */
export async function getSessionSnapshots(
  sessionId: number,
  workspaceId: number,
): Promise<{ run: Run; events: RunMessageRow[] }[]> {
  await requireUser()
  await requireSession(sessionId, workspaceId)
  const runs = await listRunsForSession(sessionId)
  // One batched query for every run's events rather than one per run — the
  // same lesson `getAskRunSnapshots` records: 18 concurrent queries against a
  // small pool stalled this page and starved the SSE stream at the same time.
  const eventsByRun = await listRunEventsForRuns(runs.map((r) => r.id))
  return runs.map((run) => ({ run, events: eventsByRun.get(run.id) ?? [] }))
}

/** First line of the first message, used as the session's automatic title. */
function deriveTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? text
  const clean = firstLine.trim().replace(/\s+/g, ' ')
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean
}

export async function sendSessionMessage(input: {
  sessionId: number
  workspaceId: number
  workspaceSlug: string
  prompt: string
  /** Set from the composer's project picker; persists on the session. */
  projectId?: number | null
  /** Per-turn overrides for the runtime's own declared settings — the
   * composer's mode and effort chips. Deliberately per message rather than
   * persisted on the agent: "answer this one harder" is a property of the
   * question, not a change to who is answering it. */
  runtimeConfig?: Record<string, unknown> | null
  /** Media ids the Work hero composer already uploaded before Send was
   * pressed. See `lib/work/attachment-prompt.ts`'s header for why these are
   * resolved into a filename/URL line appended to the RUNTIME prompt only —
   * never mixed into the `text` this function stores as the visible chat
   * message, which has to stay byte-identical to what the composer's
   * optimistic bubble already painted (`work-view.tsx`'s `pendingSend`
   * match), or that bubble never clears. */
  attachments?: number[] | null
}): Promise<{ runId: number }> {
  const user = await requireUser()
  const text = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!text || text.length > 20_000) throw new Error('A message between 1 and 20,000 characters is required.')
  const session = await requireSession(input.sessionId, input.workspaceId)

  if (input.projectId !== undefined && input.projectId !== session.projectId) {
    await updateSession(session.id, { projectId: input.projectId })
  }

  // Resolved server-side from the id alone, never trusting a client-supplied
  // filename/URL — the same instinct `postChannelMessage` applies by storing
  // only ids and letting the reader resolve display info. Scoped to THIS
  // workspace so an id from somewhere else can never smuggle another
  // workspace's file name into a prompt.
  const attachmentIds = (input.attachments ?? []).filter((id) => Number.isFinite(id))
  let promptForAgent = text
  if (attachmentIds.length > 0) {
    const payload = await getPayloadClient()
    const found = await payload.find({
      collection: 'media',
      where: { id: { in: attachmentIds }, workspace: { equals: input.workspaceId } },
      limit: attachmentIds.length,
      depth: 0,
      overrideAccess: true,
    })
    const files = found.docs.map((doc) => ({
      filename: doc.filename ?? 'file',
      url: `/api/media/${doc.id}/file`,
    }))
    promptForAgent = text + formatAttachmentsForPrompt(files)
  }

  let run
  try {
    run = await enqueueRun({
      agentId: session.agentId,
      sessionId: session.id,
      originatorUser: user.id,
      accountableUser: user.id,
      // The raw message plus, when there are attachments, the resolved
      // filename/URL list appended above. See this file's header for why no
      // OTHER context is ever prefixed in.
      prompt: promptForAgent,
      runtimeConfig: input.runtimeConfig ?? null,
      attachments: attachmentIds,
    })
  } catch (err) {
    // The active-run index now includes the session, so this can only mean a
    // turn is already in flight in THIS conversation — which is worth saying
    // plainly rather than surfacing a unique-violation.
    const message = err instanceof Error ? err.message : String(err)
    if (/uidx|unique/i.test(message)) {
      throw new Error('This conversation is still answering. Wait for it to finish, or stop it first.')
    }
    throw err
  }

  // The user's own message is not something Hermes emits — only its
  // `session`/`message`/`done` events reach the stream — so without writing
  // it here the thread has nothing to render for "what I just said". Seq 1,
  // always: `appendRunEvent` assigns sequence atomically and this is the
  // first event of a fresh run. Observed live when it was missing: the
  // optimistic bubble never resolved into a real one, so it stayed pinned
  // below the answer and the composer never left its "answering" state.
  await appendRunEvent(run.id, { type: 'message', role: 'user', text })

  // An untitled session takes its name from its first message; a title the
  // user set is never overwritten.
  if (!session.title && session.titleSource !== 'user') {
    await updateSession(session.id, { title: deriveTitle(text) })
  }
  await touchSession(session.id)
  revalidatePath(`/workspace/${input.workspaceSlug}/work`)
  return { runId: run.id }
}

export async function stopSessionRun(runId: number): Promise<{ cancelled: boolean }> {
  await requireUser()
  return requestRunCancel(runId)
}

export async function renameWorkSession(input: {
  sessionId: number
  workspaceId: number
  title: string
}): Promise<ChatSession | null> {
  await requireUser()
  await requireSession(input.sessionId, input.workspaceId)
  const title = input.title.trim().slice(0, 200)
  return updateSession(input.sessionId, { title, titleSource: title ? 'user' : 'auto' })
}

export async function setWorkSessionPinned(input: {
  sessionId: number
  workspaceId: number
  pinned: boolean
}): Promise<ChatSession | null> {
  await requireUser()
  await requireSession(input.sessionId, input.workspaceId)
  return updateSession(input.sessionId, { pinned: input.pinned })
}

export async function setWorkSessionArchived(input: {
  sessionId: number
  workspaceId: number
  archived: boolean
}): Promise<ChatSession | null> {
  await requireUser()
  await requireSession(input.sessionId, input.workspaceId)
  return updateSession(input.sessionId, { archived: input.archived })
}

export async function deleteWorkSession(input: {
  sessionId: number
  workspaceId: number
  workspaceSlug: string
}): Promise<void> {
  await requireUser()
  await requireSession(input.sessionId, input.workspaceId)
  await deleteSession(input.sessionId)
  revalidatePath(`/workspace/${input.workspaceSlug}/work`)
}

export async function setWorkSessionProject(input: {
  sessionId: number
  workspaceId: number
  projectId: number | null
}): Promise<ChatSession | null> {
  await requireUser()
  await requireSession(input.sessionId, input.workspaceId)
  return updateSession(input.sessionId, { projectId: input.projectId })
}

/**
 * Worktrees a session can be bound to, for the composer's picker.
 *
 * Only ACTIVE ones, and only for the chosen project: binding a session to a
 * removed worktree would send its next turn to a directory that no longer
 * exists (the dispatcher falls back to a disposable checkout in that case,
 * but offering the choice at all would be misleading).
 */
export async function listProjectWorktreeOptions(
  projectId: number,
): Promise<Array<{ id: number; label: string; branch: string; path: string }>> {
  await requireUser()
  const rows = await listWorktreesForProject(projectId)
  return rows
    .filter((row) => row.status === 'active')
    .map((row) => ({
      id: row.id,
      label: row.displayName || row.branch,
      branch: row.branch,
      path: row.path,
    }))
}

/** Binds (or unbinds) the worktree a session's turns run inside. */
export async function setWorkSessionWorktree(input: {
  sessionId: number
  workspaceId: number
  worktreeId: number | null
}): Promise<ChatSession | null> {
  await requireUser()
  await requireSession(input.sessionId, input.workspaceId)
  if (input.worktreeId != null) {
    const worktree = await getWorktree(input.worktreeId)
    if (!worktree || worktree.status === 'removed') throw new Error('That worktree is no longer available.')
  }
  return updateSession(input.sessionId, { worktreeId: input.worktreeId })
}

/**
 * Promotes one assistant reply into a page.
 *
 * The other half of the in-page agent block: a conversation can become a
 * document, just as a document can hold a conversation. A good answer trapped
 * in a chat log is the failure mode this whole product exists to remove.
 *
 * The new page carries the session's project, so it appears in that project's
 * Pages tab without anyone filing it, and links back to the conversation it
 * came from.
 */
export async function convertReplyToPage(input: {
  sessionId: number
  workspaceId: number
  workspaceSlug: string
  /** The assistant message's own content blocks, exactly as rendered. */
  content: ChatContent[]
  /** Suggested title; the first line of the reply when the caller has one. */
  title?: string
}): Promise<{ pageId: number; blockCount: number }> {
  const user = await requireUser()
  const session = await requireSession(input.sessionId, input.workspaceId)
  if (!Array.isArray(input.content) || input.content.length === 0) {
    throw new Error('There is nothing in that reply to turn into a page.')
  }

  const payload = await getPayloadClient()
  const title = (input.title ?? '').trim() || 'Untitled'
  const page = await payload.create({
    collection: 'pages',
    data: {
      title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
      workspace: input.workspaceId,
      // Filed where the work already lives, rather than at the workspace root.
      ...(session.projectId ? { project: session.projectId } : {}),
      createdBy: user.id,
    } as never,
    overrideAccess: true,
  })

  const blockCount = await appendMessageToPage(payload, page.id, input.content)
  revalidatePath(`/workspace/${input.workspaceSlug}/work`)
  return { pageId: page.id, blockCount }
}
