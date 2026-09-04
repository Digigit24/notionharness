// Mentioning an agent in a channel makes it answer.
//
// This is the loop the whole channel feature exists for, and until now it was
// missing: `parseMentions` indexed who was named and nothing consumed that
// index. Naming an agent stored a row and produced no run, no reply, and no
// work assigned to the agent that was named — the message just sat there
// looking like it had been sent to someone.
//
// Deliberately its own module rather than more of the server action: this is
// the seam where a message becomes WORK, and the rules about who gets woken
// belong somewhere a person can find them.
import { channelMessageHasRun, enqueueRun } from '@/lib/broker/runs'
import { getSession } from '@/lib/broker/sessions'
import { bestEffort } from '@/lib/failures'
import type { ChannelMessage } from '@/lib/broker/channels'

/**
 * The roster shape this needs, declared structurally rather than imported.
 *
 * NOT `TeamMember`: that type says `agentId: number`, and since migration 0013
 * a slot may be backed by a person instead, with `agent_id` NULL. Its mapper
 * runs `Number(row.agent_id)`, so a human slot arrives as agent **0** — a
 * number that passes a null check and names no agent. Taking the nullable
 * shape means "is this an agent" is a question this module can actually ask.
 */
export interface MentionRosterSlot {
  id: number
  displayName: string
  agentId: number | null
  sessionId: number | null
}

export interface MentionDispatchResult {
  /** Slots whose agent was woken, with the run started for each. */
  dispatched: Array<{ slotId: number; displayName: string; runId: number }>
  /** Mentioned slots that were deliberately NOT woken, and why. Returned so a
   * caller can say so rather than leaving a person wondering why nothing
   * happened — silence is the failure this whole module is fixing. */
  skipped: Array<{ slotId: number; displayName: string; reason: string }>
}

/**
 * What the mentioned agent is actually told.
 *
 * It gets the channel, who spoke, what they said, and — this is the part that
 * makes a reply land somewhere useful — the thread id to answer in. Without
 * that last line an agent replies into the feed and the conversation it was
 * pulled into loses its shape.
 *
 * The roster and the agent's role arrive separately, through the dispatcher's
 * own team context (see `buildPromptText`), so this does not repeat them.
 */
function buildMentionPrompt(input: {
  channelName: string
  authorName: string
  body: string
  threadRootId: number
}): string {
  return [
    `You were mentioned in #${input.channelName} by ${input.authorName}:`,
    '',
    input.body,
    '',
    'Reply in that thread with team_send_message, passing thread_root_id=' +
      String(input.threadRootId) +
      '. If this needs work rather than an answer, create or claim a task with your team tools and say so in the thread.',
  ].join(String.fromCharCode(10))
}

/**
 * Wakes every agent named in a message.
 *
 * Rules, each of which exists because the alternative is worse:
 *
 *  - **Only agent-backed slots.** A human slot has no runtime to wake; naming
 *    a colleague is a notification, which the mention index already provides.
 *  - **Never the author.** Mentioning yourself must not start a run answering
 *    your own message.
 *  - **Never twice for one message.** A retried action or a double submit would
 *    otherwise put two identical replies in one thread, which is the most
 *    visible way this feature can embarrass itself.
 *  - **A slot with no session is skipped and SAID so.** The run is bound to the
 *    slot's own session, because that is what `getTeamBindingForSession` joins
 *    on to hand the agent its team tools and its `TEAM_SLOT_ID`. Without a
 *    session the agent would run with no team identity at all — worse than not
 *    running, because it would look like it worked.
 */
export async function dispatchMentions(input: {
  message: ChannelMessage
  channelName: string
  roster: MentionRosterSlot[]
  authorName: string
  accountableUserId: number
}): Promise<MentionDispatchResult> {
  const result: MentionDispatchResult = { dispatched: [], skipped: [] }

  const mentionedSlotIds = input.message.mentions
    .filter((mention) => mention.type === 'slot')
    .map((mention) => mention.id)
  if (mentionedSlotIds.length === 0) return result

  // Answering a reply threads under its ROOT, so a conversation stays one
  // thread rather than sprouting a new one per exchange.
  const threadRootId = input.message.threadRootId ?? input.message.id

  // One check for the whole message, not one per slot: the guard is "has this
  // message been dispatched", and two mentions in one message are one dispatch.
  const alreadyDispatched = await bestEffort(
    channelMessageHasRun(input.message.id),
    'a duplicate-guard we cannot read must not stop the mention from being answered at all',
    { channelMessageId: input.message.id },
  )
  if (alreadyDispatched) {
    for (const slotId of mentionedSlotIds) {
      const slot = input.roster.find((m) => m.id === slotId)
      result.skipped.push({
        slotId,
        displayName: slot?.displayName ?? `slot ${slotId}`,
        reason: 'this message has already been answered',
      })
    }
    return result
  }

  for (const slotId of mentionedSlotIds) {
    const slot = input.roster.find((member) => member.id === slotId)
    if (!slot) continue
    const label = slot.displayName

    if (slot.id === input.message.fromSlotId) continue
    if (!slot.agentId) {
      result.skipped.push({ slotId, displayName: label, reason: 'is a person, not an agent' })
      continue
    }
    if (!slot.sessionId) {
      result.skipped.push({
        slotId,
        displayName: label,
        reason: 'has no conversation to run in, so it would have no team tools',
      })
      continue
    }

    // A slot whose session has since been deleted would enqueue a run that can
    // never resolve its team binding.
    const session = await bestEffort(
      getSession(slot.sessionId),
      'a session we cannot read is treated as gone, which is said out loud below rather than dispatched blind',
      { slotId, sessionId: slot.sessionId },
    )
    if (!session) {
      result.skipped.push({ slotId, displayName: label, reason: 'its conversation no longer exists' })
      continue
    }

    try {
      const run = await enqueueRun({
        agentId: slot.agentId,
        sessionId: slot.sessionId,
        originatorUser: input.accountableUserId,
        accountableUser: input.accountableUserId,
        prompt: buildMentionPrompt({
          channelName: input.channelName,
          authorName: input.authorName,
          body: input.message.body,
          threadRootId,
        }),
        channelMessageId: input.message.id,
      })
      result.dispatched.push({ slotId, displayName: label, runId: run.id })
    } catch (err) {
      // The active-run unique index refuses a second concurrent run in one
      // session, which is the common cause here and is not an error worth
      // failing the POST over — the person's message was posted either way.
      result.skipped.push({
        slotId,
        displayName: label,
        reason: err instanceof Error && /active|unique|duplicate/i.test(err.message)
          ? 'is already working on something in this conversation'
          : 'could not be started',
      })
    }
  }

  return result
}
