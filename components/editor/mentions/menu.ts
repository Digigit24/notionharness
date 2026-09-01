import type { EditorHost } from '@blocksuite/block-std'
import type { AffineInlineEditor } from '@blocksuite/affine-components/rich-text'
import type { LinkedMenuGroup } from '@blocksuite/blocks'
import { LinkedWidgetUtils } from '@blocksuite/blocks'
import { html } from 'lit'
import { insertMentionNode } from './insert-mention'
import type { MentionAttribute } from './schema'

interface MentionableUser {
  id: string
  name: string | null
  email: string
  image: string | null
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

function createPeopleMenuGroup(
  query: string,
  abort: () => void,
  inlineEditor: AffineInlineEditor,
  users: MentionableUser[],
): LinkedMenuGroup {
  return {
    name: 'People',
    items: users.map((user) => {
      const mention: MentionAttribute = { userId: user.id, name: user.name || user.email }
      return {
        key: user.id,
        name: mention.name,
        icon: personIcon(user.image),
        suffix: user.name ? user.email : undefined,
        action: () => {
          abort()
          insertMentionNode({ inlineEditor, user: mention })
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

/**
 * Combines BlockSuite's stock "link to doc / new doc" groups with a new
 * "People" group backed by real Better Auth accounts, so the existing `@`
 * trigger stays the single unified mention menu (matching Notion's own UX)
 * instead of adding a second, colliding `@`-trigger system.
 */
export function getMenusWithMentions(
  query: string,
  abort: () => void,
  editorHost: EditorHost,
  inlineEditor: AffineInlineEditor,
): Promise<LinkedMenuGroup[]> {
  return fetchMentionableUsers(query).then((users) => {
    const groups: LinkedMenuGroup[] = []
    if (users.length > 0) {
      groups.push(createPeopleMenuGroup(query, abort, inlineEditor, users))
    }
    groups.push(LinkedWidgetUtils.createLinkedDocMenuGroup(query, abort, editorHost, inlineEditor))
    groups.push(LinkedWidgetUtils.createNewDocMenuGroup(query, abort, editorHost, inlineEditor))
    return groups
  })
}
