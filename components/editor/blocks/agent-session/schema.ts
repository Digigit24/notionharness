import { defineBlockSchema, type SchemaToModel } from '@/lib/blocksuite-store'

/**
 * An agent conversation living inside a page.
 *
 * This is the block the whole product thesis rests on: a Slack-style thread,
 * a Notion page and an agent chat window are three separate places to do one
 * job, and this collapses them. Type `@` an agent on a page and the
 * conversation starts right there, in the document, and stays there.
 *
 * Same "reference, never container" shape as `run-card/schema.ts` and
 * `task/schema.ts`: the block holds a pointer to a `chat_sessions` row and
 * nothing else. Messages, runs and transcript all live in the broker, which
 * is what lets the same conversation be opened full-screen in Work — the
 * block and the Work page are two views of one row, not two copies of it.
 *
 * `agentId` is stored alongside so a block whose session has not been
 * created yet (the moment between insertion and the first message) still
 * knows who it is talking to.
 *
 * NAMING, and it is load-bearing: the flavour must start `affine:embed-`.
 * BlockSuite validates containment from the PARENT's side too, and
 * `affine:note` accepts `affine:embed-*` children by pattern. A flavour
 * named `notionforge:agent-session` typechecks, registers, and then throws
 * "Block cannot have parent: affine:note" the first time you insert one —
 * confirmed live. That is why the two existing custom blocks here are called
 * `affine:embed-task` and `affine:embed-run-card`.
 */
export const AgentSessionBlockSchema = defineBlockSchema({
  flavour: 'affine:embed-agent-session',
  props: () => ({
    sessionId: null as number | null,
    agentId: null as number | null,
    /** Collapsed blocks render as a single summary row. Persisted, because
     * whether a conversation is folded away is part of how the page reads. */
    collapsed: false as boolean,
  }),
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:note'],
    children: [],
  },
})

export type AgentSessionBlockModel = SchemaToModel<typeof AgentSessionBlockSchema>

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace BlockSuite {
    interface BlockModels {
      'affine:embed-agent-session': AgentSessionBlockModel
    }
  }
}
