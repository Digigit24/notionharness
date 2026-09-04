import type { EditorHost } from '@/lib/blocksuite-block-std'
import type { AffineInlineEditor } from '@/lib/blocksuite-affine-components'
import type { LinkedMenuGroup } from '@/lib/blocksuite-blocks'
import { LinkedWidgetUtils } from '@/lib/blocksuite-blocks'
import { html } from 'lit'
import { insertMentionNode } from './insert-mention'
import type { MentionAttribute } from './schema'
import {
  openAgentSessionBlock,
  type AgentSessionDocLike,
} from '@/components/editor/blocks/agent-session/open-session-block'

interface MentionableUser {
  id: string
  name: string | null
  email: string
  image: string | null
}

interface MentionableAgent {
  id: number
  name: string
  model: string | null
}

async function fetchMentionableUsers(query: string): Promise<MentionableUser[]> {
  try {
    const res = await fetch(`/api/users${query ? `?q=${encodeURIComponent(query)}` : ''}`)
    if (!res.ok) return []
    const data = (await res.json()) as { users: MentionableUser[] }
    return data.users
  } catch {
    return []
  }
}

// `/api/agents` requires a `workspaceId` (agents are workspace-scoped, unlike
// the app-wide `user` table Better Auth mentions read from), sourced from the
// `data-workspace-id` attribute `BlockSuiteEditor.tsx` sets on the editor's
// container — the same lookup `native-database-block.ts` already relies on.
async function fetchMentionableAgents(query: string, editorHost: EditorHost): Promise<MentionableAgent[]> {
  const workspaceId = editorHost.closest('[data-workspace-id]')?.getAttribute('data-workspace-id')
  if (!workspaceId) return []
  try {
    const params = new URLSearchParams({ workspaceId })
    if (query) params.set('q', query)
    const res = await fetch(`/api/agents?${params.toString()}`)
    if (!res.ok) return []
    const data = (await res.json()) as { agents: MentionableAgent[] }
    return data.agents
  } catch {
    return []
  }
}

function createPeopleMenuGroup(
  abort: () => void,
  inlineEditor: AffineInlineEditor,
  users: MentionableUser[],
): LinkedMenuGroup {
  return {
    name: 'People',
    items: users.map((user) => {
      const mention: MentionAttribute = { userId: user.id, name: user.name || user.email, kind: 'user' }
      return {
        key: user.id,
        name: mention.name,
        icon: personIcon(user.image),
        suffix: user.name ? user.email : undefined,
        action: () => {
          abort()
          insertMentionNode({ inlineEditor, mention })
        },
      }
    }),
  }
}

function createAgentMenuGroup(
  abort: () => void,
  editorHost: EditorHost,
  inlineEditor: AffineInlineEditor,
  agents: MentionableAgent[],
): LinkedMenuGroup {
  return {
    name: 'Agents',
    items: agents.map((agent) => {
      const mention: MentionAttribute = { userId: String(agent.id), name: agent.name, kind: 'agent' }
      return {
        key: `agent-${agent.id}`,
        name: mention.name,
        icon: agentIcon(),
        suffix: agent.model ?? undefined,
        action: () => {
          abort()
          insertMentionNode({ inlineEditor, mention })
          // Picking an agent from the `@` menu OPENS the conversation, it
          // does not merely leave a coloured chip behind. Mentioning an agent
          // in a document is a request to talk to it, and making the user
          // then hunt for and click the chip they just created is a step that
          // exists for no reason. Clicking an existing chip still works, and
          // reveals this same block rather than adding a second one.
          //
          // Deferred a frame: the caret and the inserted delta have to settle
          // before the anchor paragraph can be resolved from the DOM.
          requestAnimationFrame(() => {
            const doc = (editorHost as EditorHost & { doc?: AgentSessionDocLike }).doc
            if (!doc) return
            // The paragraph being typed into: the inline editor's own root
            // element sits inside it, so walking up finds the block that
            // should host the conversation.
            const anchorBlockId =
              inlineEditor.rootElement?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null
            openAgentSessionBlock({
              doc,
              anchorBlockId,
              agentId: agent.id,
              scrollTarget: editorHost,
            })
          })
        },
      }
    }),
  }
}

function personIcon(image: string | null) {
  return image
    ? html`<img src=${image} alt="" style="width:16px;height:16px;border-radius:50%;object-fit:cover;" />`
    : html`<span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;">👤</span>`
}

function agentIcon() {
  return html`<span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;">🤖</span>`
}

/**
 * Combines BlockSuite's stock "link to doc / new doc" groups with new
 * "People" (real Better Auth accounts) and "Agents" (real `agents` collection
 * docs, ROADMAP 6.3) groups, so the existing `@` trigger stays the single
 * unified mention menu (matching Notion's own UX) instead of adding a second,
 * colliding `@`-trigger system.
 */
export function getMenusWithMentions(
  query: string,
  abort: () => void,
  editorHost: EditorHost,
  inlineEditor: AffineInlineEditor,
): Promise<LinkedMenuGroup[]> {
  return Promise.all([fetchMentionableUsers(query), fetchMentionableAgents(query, editorHost)]).then(
    ([users, agents]) => {
      const groups: LinkedMenuGroup[] = []
      if (users.length > 0) {
        groups.push(createPeopleMenuGroup(abort, inlineEditor, users))
      }
      if (agents.length > 0) {
        groups.push(createAgentMenuGroup(abort, editorHost, inlineEditor, agents))
      }
      groups.push(LinkedWidgetUtils.createLinkedDocMenuGroup(query, abort, editorHost, inlineEditor))
      groups.push(LinkedWidgetUtils.createNewDocMenuGroup(query, abort, editorHost, inlineEditor))
      return groups
    },
  )
}
