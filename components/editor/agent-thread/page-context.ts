import type { Doc } from '@/lib/blocksuite-store'
import type { EditorHost } from '@/lib/blocksuite-block-std'

/**
 * Extracted out of `block-anchored-thread.tsx` (ROADMAP 6.2) so B3.5's new
 * `/run`/`/summarise`/`/ask` slash items (`components/editor/slash-commands/
 * page-commands.ts`) and `resolve-agent.ts` share the exact same "which page
 * is this editor showing" / "which workspace is it in" lookups instead of a
 * second, drifting copy — both need them, neither owns them more than the
 * other.
 */

/** Client-side docs are created as `page-${pageId}` (see BlockSuiteEditor.tsx
 * and lib/blocksuite-doc.ts's `loadDoc`) — parsing this back out avoids
 * needing a second way to thread the page id through. */
export function pageIdFromDoc(doc: Doc): number | null {
  const match = /^page-(\d+)$/.exec(doc.id)
  return match ? Number(match[1]) : null
}

/** Same `data-workspace-id` lookup `native-database-block.ts` and the
 * @mention menu already use — set on the editor's container in
 * BlockSuiteEditor.tsx. */
export function workspaceIdFromHost(host: EditorHost): string | null {
  return host.closest('[data-workspace-id]')?.getAttribute('data-workspace-id') ?? null
}

/** Same `data-workspace-slug` lookup `native-database-block.ts`'s own
 * `_workspaceSlug` getter and the run-card block use — set on the editor's
 * container only when a caller passes `workspaceSlug` (some embedding
 * contexts, like the record-detail drawer, don't). */
export function workspaceSlugFromHost(host: EditorHost): string | null {
  return host.closest('[data-workspace-slug]')?.getAttribute('data-workspace-slug') ?? null
}
