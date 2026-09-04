'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { X, ExternalLink } from 'lucide-react'

import { BlockSuiteEditor } from '@/components/editor/BlockSuiteEditor'
import { Button } from '@/components/ui/button'

export interface PanelArtifact {
  id: number
  name: string
  kind: 'page' | 'html'
  pageId: number | null
  htmlContent: string | null
  pageTitle: string
  pageDocState: unknown
  pageLocked: boolean
}

/**
 * R8.6 — the artifact panel.
 *
 * "Side by side, not a link... the panel opens over the current route and
 * holds the full editor, not a preview. Editing it is editing the page."
 *
 * It holds the real `BlockSuiteEditor`, the same component the page route
 * mounts, so an edit here is an edit to the page and there is no second
 * rendering path to keep in step.
 *
 * Two honest limits, both structural rather than oversights:
 *
 * 1. "Over the current route" here means over the Artifacts section. Opening
 *    a panel over *any* route (a conversation, a task) needs a slot in the
 *    app shell, and `components/shell/*` is not this unit's to change. What
 *    exists is the panel and its content; hosting it elsewhere is wiring, not
 *    a rewrite.
 * 2. Blocks appear as they are written because `BlockSuiteEditor` already
 *    polls `/api/pages/[id]/live-state` for exactly that (see its own
 *    comment). R8.6 wants one SSE subscription per open artifact instead,
 *    which is a change inside the editor and not here — the panel would
 *    consume it unchanged.
 */
export function ArtifactPanel({
  workspaceId,
  workspaceSlug,
  artifact,
}: {
  workspaceId: number
  workspaceSlug: string
  artifact: PanelArtifact | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  if (!artifact) return null

  const close = () => {
    const next = new URLSearchParams(searchParams.toString())
    next.delete('artifact')
    const query = next.toString()
    router.push(query ? `${pathname}?${query}` : pathname)
  }

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l border-black/10 bg-white shadow-xl dark:border-white/10 dark:bg-neutral-950"
      aria-label={`Artifact: ${artifact.name}`}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{artifact.name}</h2>
        {artifact.pageId != null && (
          // The panel is where you work; this is for when you want the
          // document to be the whole window. Same page either way.
          <Button asChild size="sm" variant="ghost">
            <Link href={`/workspace/${workspaceSlug}/p/${artifact.pageId}`}>
              <ExternalLink size={14} />
              Open as page
            </Link>
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={close} aria-label="Close">
          <X size={14} />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {artifact.kind === 'html' ? (
          <iframe
            title={artifact.name}
            // R8.7 — "HTML artifacts render sandboxed, with no same-origin
            // access and no ambient credentials." `srcDoc` with a sandbox
            // that omits `allow-same-origin` puts the document in an opaque
            // origin: it cannot read this page's DOM, cookies, localStorage
            // or call our API as the signed-in user. `allow-scripts` is
            // granted because a generated document may legitimately need it,
            // and it is only safe BECAUSE same-origin is withheld — granting
            // both together is equivalent to no sandbox at all.
            sandbox="allow-scripts"
            srcDoc={artifact.htmlContent ?? ''}
            className="h-full w-full border-0 bg-white"
          />
        ) : artifact.pageId == null ? (
          <p className="px-4 py-6 text-sm text-black/50 dark:text-white/50">
            This artifact&apos;s document no longer exists. Nothing was recovered, and the record is kept so you can see that it
            happened.
          </p>
        ) : (
          <BlockSuiteEditor
            pageId={artifact.pageId}
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            initialTitle={artifact.pageTitle}
            initialDocState={artifact.pageDocState}
            locked={artifact.pageLocked}
          />
        )}
      </div>
    </aside>
  )
}
