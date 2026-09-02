import type { EditorHost } from '@/lib/blocksuite-block-std'
import { popMenu, popupTargetFromElement, menu } from '@/lib/blocksuite-affine-components'
import { workspaceIdFromHost } from './page-context'

export interface MentionableAgent {
  id: number
  name: string
  model: string | null
}

/**
 * Extracted out of `block-anchored-thread.tsx` (ROADMAP 6.2) so B3.5's
 * `/run`/`/summarise` slash items (`components/editor/slash-commands/
 * page-commands.ts`) resolve which agent a run should target the exact same
 * way "Ask agent" already does, rather than a second, drifting copy of the
 * same picker logic.
 *
 * Resolves which agent a run should target: the workspace's only enabled
 * agent is used silently (no reason to make the common case click twice),
 * more than one prompts a picker anchored to `anchorElement`, zero surfaces
 * a clear error instead of enqueueing a run nothing can ever execute.
 */
export async function resolveAgent(host: EditorHost, anchorElement: HTMLElement): Promise<MentionableAgent | null> {
  const workspaceId = workspaceIdFromHost(host)
  if (!workspaceId) {
    console.error('[ask-agent] Could not resolve a workspace id — aborting.')
    return null
  }

  const res = await fetch(`/api/agents?workspaceId=${workspaceId}`)
  if (!res.ok) {
    console.error('[ask-agent] Failed to load agents for this workspace.')
    return null
  }
  const { agents } = (await res.json()) as { agents: MentionableAgent[] }
  if (agents.length === 0) {
    console.error('[ask-agent] No agents configured for this workspace — create one before asking an agent.')
    return null
  }
  if (agents.length === 1) return agents[0]

  return new Promise((resolve) => {
    popMenu(popupTargetFromElement(anchorElement), {
      options: {
        title: { text: 'Ask which agent?' },
        items: agents.map((agent) =>
          menu.action({
            name: agent.model ? `${agent.name} (${agent.model})` : agent.name,
            select: () => resolve(agent),
          }),
        ),
        onClose: () => resolve(null),
      },
    })
  })
}
