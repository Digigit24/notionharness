/**
 * Opens an agent conversation on the page.
 *
 * Shared by the two ways of asking for one — picking an agent from the `@`
 * menu, and clicking an existing `@agent` chip — so both behave identically:
 * an agent already talking on this page is revealed rather than duplicated,
 * and a new one is inserted directly after the paragraph that asked for it.
 *
 * The document API is typed structurally rather than imported. The editor's
 * real types live behind the `lib/blocksuite-*` re-export shims, and pulling
 * the full `Doc` type into an inline component drags the whole store with it.
 */
export interface AgentSessionDocLike {
  getBlocksByFlavour(
    flavour: string,
  ): Array<{ id: string; model: { id: string; agentId?: number | null } }>
  getBlock(id: string): { model: AgentSessionBlockModelLike } | null | undefined
  getParent(model: AgentSessionBlockModelLike): AgentSessionBlockModelLike | null
  addBlock(
    flavour: string,
    props: Record<string, unknown>,
    parent: AgentSessionBlockModelLike,
    index?: number,
  ): string
}

export interface AgentSessionBlockModelLike {
  id: string
  children: AgentSessionBlockModelLike[]
}

/**
 * The flavour MUST keep its `affine:embed-` prefix.
 *
 * BlockSuite validates containment from the parent's side as well as the
 * child's, and `affine:note` accepts `affine:embed-*` children by pattern.
 * A flavour named anything else typechecks, registers, and then throws
 * "Block cannot have parent: affine:note" on the first insert — confirmed
 * live, and the reason the other custom blocks here are named as they are.
 */
export const AGENT_SESSION_FLAVOUR = 'affine:embed-agent-session'

export function openAgentSessionBlock({
  doc,
  anchorBlockId,
  agentId,
  scrollTarget,
}: {
  doc: AgentSessionDocLike
  /** The block the request came from — the conversation is inserted after it. */
  anchorBlockId: string | null
  agentId: number
  /** Where to look for an existing block's element, to scroll it into view. */
  scrollTarget?: ParentNode | null
}): { created: boolean; blockId: string | null } {
  const existing = doc
    .getBlocksByFlavour(AGENT_SESSION_FLAVOUR)
    .find((entry) => entry.model.agentId === agentId)
  if (existing) {
    const el = scrollTarget?.querySelector(`[data-block-id="${existing.id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return { created: false, blockId: existing.id }
  }

  const anchorModel = anchorBlockId ? doc.getBlock(anchorBlockId)?.model : null
  const parent = anchorModel ? doc.getParent(anchorModel) : null
  if (!parent || !anchorModel) return { created: false, blockId: null }

  const index = parent.children.findIndex((child) => child.id === anchorModel.id)
  const blockId = doc.addBlock(
    AGENT_SESSION_FLAVOUR,
    { agentId, sessionId: null, collapsed: false },
    parent,
    index + 1,
  )
  return { created: true, blockId }
}
