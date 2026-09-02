'use client'

import { useEffect, useRef, useState } from 'react'
import { syncPageDoc } from '@/app/(app)/actions'
import { NativeDatabaseBlockSchema } from '@/components/editor/blocks/native-database/schema'
import { NativeDatabaseBlockSpec } from '@/components/editor/blocks/native-database/spec'
import { registerNativeDatabaseSlashMenuItem } from '@/components/editor/blocks/native-database/slash-menu'
import { RunCardBlockSchema } from '@/components/editor/blocks/run-card/schema'
import { RunCardBlockSpec } from '@/components/editor/blocks/run-card/spec'
import { MentionSpec } from '@/components/editor/mentions/spec'
import { AskAgentToolbarSpec } from '@/components/editor/agent-thread/toolbar-trigger'
// Side-effect only: registers the "Ask agent" handler the toolbar trigger
// calls through (see components/editor/agent-thread/registry.ts).
import '@/components/editor/agent-thread/block-anchored-thread'
import type { AffineEditorContainer } from '@/lib/blocksuite-presets'
import type { Doc } from '@/lib/blocksuite-store'
import { ensureBlockSuiteEffects as loadBlockSuiteEffects } from '@/lib/blocksuite-effects'
import { loadBlockSuiteRuntime } from '@/lib/blocksuite-runtime'

const AUTOSAVE_DELAY_MS = 500
const LIVE_STATE_POLL_MS = 3000

let blockSuiteEffectsReady: Promise<void> | null = null

// BlockSuite's custom elements can only be registered once per page, in the browser.
function ensureBlockSuiteEffects() {
  if (!blockSuiteEffectsReady) {
    blockSuiteEffectsReady = Promise.all([
      loadBlockSuiteEffects(),
      import('@/components/editor/blocks/native-database/effects'),
      import('@/components/editor/blocks/run-card/effects'),
      import('@/components/editor/mentions/effects'),
    ]).then(([, nativeDatabaseModule, runCardModule, mentionsModule]) => {
      nativeDatabaseModule.effects()
      runCardModule.effects()
      mentionsModule.effects()
    })
  }
  return blockSuiteEffectsReady
}

function base64ToUpdate(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function updateToBase64(update: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < update.length; i++) binary += String.fromCharCode(update[i])
  return btoa(binary)
}

export function BlockSuiteEditor({
  pageId,
  workspaceId,
  workspaceSlug,
  initialTitle,
  initialDocState,
  locked,
}: {
  pageId: number
  workspaceId: number
  // Optional: other embedding contexts (e.g. the record-detail drawer) mount
  // this editor without workspace-routing context — features that need the
  // slug (like the native Teable block's "open as full page" link) just
  // no-op when it isn't set, rather than forcing every call site to pass one.
  workspaceSlug?: string
  initialTitle: string
  initialDocState: unknown
  locked: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [mountError, setMountError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    let editor: AffineEditorContainer | null = null
    let doc: Doc | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let onUpdate: (() => void) | null = null
    let liveStateTimer: ReturnType<typeof setInterval> | null = null
    let applyingRemote = false

    setMountError(null)

    async function mount() {
      // Mounting spans dynamic imports, Yjs doc construction, and BlockSuite's
      // own editor/widget initialization — any of these throwing previously
      // left `containerRef`'s div silently empty (no editor, no slash menu,
      // nothing clickable) with no visible signal of what went wrong. Surface
      // it instead: log the real error and show a retry affordance.
      try {
        await ensureBlockSuiteEffects()
        if (cancelled) return

        const { presets, store, schemas, blocks } = await loadBlockSuiteRuntime()
        const { AffineEditorContainer } = presets
        const { DocCollection, Schema, Text } = store
        const { AffineSchemas } = schemas
        const { PageEditorBlockSpecs } = blocks
        if (cancelled) return

        const schema = new Schema().register(AffineSchemas).register([NativeDatabaseBlockSchema, RunCardBlockSchema])
        const collection = new DocCollection({ schema })
        collection.meta.initialize()

        doc = collection.createDoc({ id: `page-${pageId}` })

        const storedUpdate =
          initialDocState && typeof initialDocState === 'object' && 'update' in initialDocState
            ? (initialDocState as { update: unknown }).update
            : null

        let hydrated = false
        if (typeof storedUpdate === 'string' && storedUpdate.length > 0) {
          try {
            DocCollection.Y.applyUpdate(doc.spaceDoc, base64ToUpdate(storedUpdate), 'hydrate')
            hydrated = true
          } catch (err) {
            console.error(`Failed to hydrate BlockSuite doc for page ${pageId}, starting fresh.`, err)
          }
        }

        doc.load(() => {
          if (hydrated && doc?.root) return
          const rootId = doc!.addBlock('affine:page', { title: new Text(initialTitle) })
          doc!.addBlock('affine:surface', {}, rootId)
          const noteId = doc!.addBlock('affine:note', {}, rootId)
          doc!.addBlock('affine:paragraph', {}, noteId)
        })

        doc.awarenessStore.setReadonly(doc.blockCollection, locked)

        editor = new AffineEditorContainer()
        editor.pageSpecs = [
          ...PageEditorBlockSpecs,
          ...NativeDatabaseBlockSpec,
          ...RunCardBlockSpec,
          ...MentionSpec,
          ...AskAgentToolbarSpec,
        ]
        editor.doc = doc
        editor.mode = 'page'
        editor.style.display = 'block'
        editor.style.width = '100%'

        if (containerRef.current) {
          containerRef.current.dataset.workspaceId = String(workspaceId)
          if (workspaceSlug) containerRef.current.dataset.workspaceSlug = workspaceSlug
          containerRef.current.replaceChildren(editor)
          registerNativeDatabaseSlashMenuItem(containerRef.current)
        }

        onUpdate = () => {
          if (applyingRemote) return
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => {
            if (!doc) return
            const update = DocCollection.Y.encodeStateAsUpdate(doc.spaceDoc)
            void syncPageDoc(pageId, updateToBase64(update))
          }, AUTOSAVE_DELAY_MS)
        }
        doc.spaceDoc.on('update', onUpdate)

        // ROADMAP 6.1 — "streams blocks into the page as it works": an agent
        // writes through /api/daemon/page-writes out-of-band (see
        // lib/blocksuite-doc.ts's applyDocSync, which already merges rather
        // than overwrites), but this tab's own live Y.Doc has no way to know
        // that happened until it reloads. Poll while the page is open;
        // `Y.applyUpdate` is commutative/idempotent, so merging the same or
        // an already-known update repeatedly is always safe. Cheap when
        // nothing's running — the endpoint only does the (larger) docState
        // fetch once a non-terminal run actually targets this page.
        let lastAppliedUpdate: string | null = null
        const pollLiveState = async () => {
          if (cancelled || !doc) return
          try {
            const res = await fetch(`/api/pages/${pageId}/live-state`)
            if (!res.ok) return
            const data = (await res.json()) as { hasActiveRun: boolean; update: string | null }
            if (!data.hasActiveRun || !data.update || data.update === lastAppliedUpdate) return
            lastAppliedUpdate = data.update
            applyingRemote = true
            try {
              DocCollection.Y.applyUpdate(doc.spaceDoc, base64ToUpdate(data.update), 'remote-agent')
            } finally {
              applyingRemote = false
            }
          } catch {
            // A later poll retries; a transient failure here must never break editing.
          }
        }
        liveStateTimer = setInterval(() => void pollLiveState(), LIVE_STATE_POLL_MS)
      } catch (err) {
        if (cancelled) return
        console.error(`Failed to mount BlockSuite editor for page ${pageId}.`, err)
        setMountError(err instanceof Error ? err.message : 'Failed to load the editor.')
      }
    }

    void mount()

    return () => {
      cancelled = true
      if (saveTimer) clearTimeout(saveTimer)
      if (liveStateTimer) clearInterval(liveStateTimer)
      if (doc && onUpdate) doc.spaceDoc.off('update', onUpdate)
      editor?.remove()
    }
  }, [pageId, workspaceId, workspaceSlug, initialTitle, initialDocState, locked, retryToken])

  return (
    <div>
      <div ref={containerRef} className="blocksuite-editor-root min-h-[200px] w-full" />
      {mountError && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-400">
          <span>Failed to load the editor: {mountError}</span>
          <button
            type="button"
            onClick={() => setRetryToken((t) => t + 1)}
            className="rounded px-2 py-1 text-xs hover:bg-red-100 dark:hover:bg-red-950/40"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}
