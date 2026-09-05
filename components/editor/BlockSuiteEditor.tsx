'use client'

import { useEffect, useRef, useState } from 'react'
import { listPendingSuggestionsForPage, syncPageDoc } from '@/app/(app)/actions'
import { NativeDatabaseBlockSchema } from '@/components/editor/blocks/native-database/schema'
import { NativeDatabaseBlockSpec } from '@/components/editor/blocks/native-database/spec'
import { registerNativeDatabaseSlashMenuItem } from '@/components/editor/blocks/native-database/slash-menu'
import { RunCardBlockSchema } from '@/components/editor/blocks/run-card/schema'
import { RunCardBlockSpec } from '@/components/editor/blocks/run-card/spec'
import { TaskBlockSchema } from '@/components/editor/blocks/task/schema'
import { AgentSessionBlockSchema } from '@/components/editor/blocks/agent-session/schema'
import { TaskBlockSpec } from '@/components/editor/blocks/task/spec'
import { AgentSessionBlockSpec } from '@/components/editor/blocks/agent-session/spec'
import { registerTaskSlashMenuItem } from '@/components/editor/blocks/task/slash-menu'
import { registerPageCommandsSlashMenuItems } from '@/components/editor/slash-commands/page-commands'
import { MentionSpec, mentionPageConfig } from '@/components/editor/mentions/spec'
import { MentionAwareDefaultInlineManagerExtension } from '@/components/editor/mentions/inline-manager-override'
import { askAgentPageConfig } from '@/components/editor/agent-thread/toolbar-trigger'
import { ConfigExtension } from '@/lib/blocksuite-block-std'
// Side-effect only: registers the "Ask agent" handler the toolbar trigger
// calls through (see components/editor/agent-thread/registry.ts).
import '@/components/editor/agent-thread/block-anchored-thread'
import type { AffineEditorContainer } from '@/lib/blocksuite-presets'
import type { Doc } from '@/lib/blocksuite-store'
import { ensureBlockSuiteEffects as loadBlockSuiteEffects } from '@/lib/blocksuite-effects'
import { watchForDuplicateBlockSuiteRegistration } from '@/lib/blocksuite-duplicate-registration'
import { loadBlockSuiteRuntime } from '@/lib/blocksuite-runtime'
import type { PageProvenanceMap } from '@/lib/provenance'
import { useBlockProvenanceHover, BlockProvenanceChip } from '@/components/editor/provenance/use-block-provenance-hover'
import { useProvenanceGreying } from '@/components/editor/provenance/use-provenance-greying'

const AUTOSAVE_DELAY_MS = 500
const LIVE_STATE_POLL_MS = 3000
// Module-level constant, not `{}` inline at the call site — a fresh object
// literal every render would change identity on every render and defeat
// `useProvenanceGreying`/`useBlockProvenanceHover`'s dependency arrays.
const EMPTY_PROVENANCE: PageProvenanceMap = {}
// ROADMAP B3.1 (Batch B-2, suggestions mode) — how often this tab checks for
// pending agent-run subtrees to apply/clear the `.suggestion-pending-subtree`
// visual treatment (app/globals.css). Same cadence as the run-card embed's
// own status poll; cheap (one small indexed query) even when nothing is pending.
const SUGGESTIONS_POLL_MS = 4000

/**
 * BlockSuite's custom elements can only be registered once per page, in the
 * browser — `customElements.define(tag, Class)` throws `NotSupportedError`
 * on a second call for the same tag, and every one of the vendored `effects()`
 * functions this calls into (`@blocksuite/blocks/effects`,
 * `@blocksuite/presets/effects`, and this app's own five block-level
 * `effects.ts` files) calls `customElements.define` unconditionally, with no
 * `customElements.get(tag)` guard of its own.
 *
 * WHY A MODULE-LEVEL GUARD WAS NOT ENOUGH — diagnosed live, not theorised:
 * this component has FIVE separate import sites (`page-canvas.tsx` and
 * `canvas-pane.tsx` via `next/dynamic`, plus static imports in
 * `artifact-panel.tsx`, `task-work-tab.tsx`, and
 * `native-database/record-detail-note.tsx`). Webpack is free to place each
 * one in its OWN chunk rather than sharing one — confirmed by two crash
 * reports naming DIFFERENT top-level chunk hashes for the exact same stack
 * shape. Each chunk that contains a copy of this module gets its OWN copy of
 * a module-level `let`, so a session that opens the editor via a second entry
 * point (e.g. a regular page, then a row's record-detail note) loads a
 * SECOND, independent copy that has never heard of the first — and calls
 * `effects()` again.
 *
 * THE ACTUAL FAILURE SHAPE THIS PRODUCES, which is why it looked unrelated to
 * "an editor mounted twice": `customElements.define` calls inside a vendored
 * `effects()` run sequentially with no try/catch between them. The first
 * duplicate tag name throws and aborts that call, so every tag AFTER it in
 * that function's list never gets defined at all. Minutes later, when
 * BlockSuite tries to construct ONE OF THOSE never-registered classes (e.g.
 * opening a different block type, or a property's config popup), the browser
 * refuses to run a bare `new` on an HTMLElement subclass that was never
 * upgraded through the custom-elements registry — `TypeError: Failed to
 * construct 'HTMLElement': Illegal constructor`, thrown deep inside Lit's own
 * render path, uncaught by anything this component's own try/catch can see
 * (that surrounds the FIRST `ensureBlockSuiteEffects()` call, which already
 * resolved successfully — this failure happens later, from unrelated code).
 *
 * THE FIX: a `window`-scoped singleton, checked and diagnosed at every call
 * site's request rather than assumed. `window` is the one thing every chunk
 * copy of this module actually shares.
 */
declare global {
  interface Window {
    __blockSuiteEffectsPromise?: Promise<void>
  }
}

function ensureBlockSuiteEffects(): Promise<void> {
  if (typeof window === 'undefined') {
    // SSR guard only — this function is only ever called from the mount
    // effect below, which never runs on the server, but the module itself
    // can still be evaluated there.
    return Promise.resolve()
  }
  watchForDuplicateBlockSuiteRegistration()
  if (window.__blockSuiteEffectsPromise) {
    console.info('[BlockSuiteEditor] custom elements already registered by an earlier mount (or another chunk copy of this module) — reusing the same promise, not re-registering.')
    return window.__blockSuiteEffectsPromise
  }
  console.info('[BlockSuiteEditor] registering BlockSuite custom elements for the first time this page load.')
  window.__blockSuiteEffectsPromise = Promise.all([
    loadBlockSuiteEffects(),
    import('@/components/editor/blocks/native-database/effects'),
    import('@/components/editor/blocks/run-card/effects'),
    import('@/components/editor/blocks/task/effects'),
    import('@/components/editor/blocks/agent-session/effects'),
    import('@/components/editor/mentions/effects'),
  ])
    .then(([, nativeDatabaseModule, runCardModule, taskModule, agentSessionModule, mentionsModule]) => {
      nativeDatabaseModule.effects()
      runCardModule.effects()
      taskModule.effects()
      agentSessionModule.effects()
      mentionsModule.effects()
      console.info('[BlockSuiteEditor] custom element registration complete.')
    })
    .catch((err) => {
      // Reset the singleton on failure — an early return here would
      // otherwise leave every later mount permanently believing
      // registration is "in flight" against a promise that already
      // rejected, silently breaking the editor for the rest of the tab's
      // life with no further attempt and no visible reason why.
      window.__blockSuiteEffectsPromise = undefined
      console.error(
        '[BlockSuiteEditor] custom element registration failed. If this names a specific tag as already defined, ' +
          'a duplicate registration slipped past the window-level guard above — that is this exact bug, not a ' +
          'stale build. Every block type registered AFTER the failing line in whichever effects() call threw is ' +
          'now missing from the custom-elements registry; constructing one later will throw "Illegal constructor".',
        err,
      )
      throw err
    })
  return window.__blockSuiteEffectsPromise
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
  provenance,
  staleBeforeMs,
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
  // ROADMAP B-2 — per-block provenance (which run/agent wrote a block, and
  // when), keyed by BlockSuite block id. `undefined` (the default, for
  // embedding contexts that don't pass it) means "no provenance data
  // available," not "this page has none" — callers that care fetch it via
  // `lib/provenance.ts` server-side and pass the resolved map down.
  provenance?: PageProvenanceMap
  // Epoch ms cutoff for the time filter's greying — `null`/`undefined` means
  // "All time" (nothing greyed). See `useProvenanceGreying`'s doc comment
  // for the exact semantics of "older."
  staleBeforeMs?: number | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [mountError, setMountError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const resolvedProvenance = provenance ?? EMPTY_PROVENANCE
  const { hoverInfo, hoverRect, keepOpen, requestClose } = useBlockProvenanceHover(containerRef, resolvedProvenance)
  useProvenanceGreying(containerRef, resolvedProvenance, staleBeforeMs ?? null)

  useEffect(() => {
    let cancelled = false
    let editor: AffineEditorContainer | null = null
    let doc: Doc | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let onUpdate: (() => void) | null = null
    let liveStateTimer: ReturnType<typeof setInterval> | null = null
    let suggestionsTimer: ReturnType<typeof setInterval> | null = null
    let applyingRemote = false
    // Block ids this tab has already tagged with the pending-suggestion CSS
    // class, so each poll only touches what actually changed.
    const appliedSuggestionBlockIds = new Set<string>()

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

        const schema = new Schema()
          .register(AffineSchemas)
          .register([NativeDatabaseBlockSchema, RunCardBlockSchema, TaskBlockSchema, AgentSessionBlockSchema])
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
          ...TaskBlockSpec,
          ...AgentSessionBlockSpec,
          ...MentionSpec,
          // Must come AFTER `...PageEditorBlockSpecs` above (array order =
          // setup-call order): this uses `di.override`, not `di.addImpl`, to
          // replace `DefaultInlineManagerExtension`'s registration — if the
          // stock spec's own `di.addImpl` ran AFTER ours instead, it would
          // throw `DuplicateServiceDefinitionError` trying to register a slot
          // we'd already filled. See mentions/inline-manager-override.ts.
          MentionAwareDefaultInlineManagerExtension,
          // Merged into a single `ConfigExtension('affine:page', ...)` call —
          // mentions/spec.ts and agent-thread/toolbar-trigger.ts each need an
          // `affine:page` config, but BlockSuite throws
          // `DuplicateServiceDefinitionError` if two separate ConfigExtension
          // calls target the same flavour (real bug hit live: "Service
          // [Config](affine:page) already exists", which killed the whole
          // editor's widget/service tree before it could finish mounting —
          // broke the slash menu and every other interaction).
          ConfigExtension('affine:page', { ...mentionPageConfig, ...askAgentPageConfig }),
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
          registerTaskSlashMenuItem(containerRef.current)
          registerPageCommandsSlashMenuItems(containerRef.current)
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

        // ROADMAP B3.1 (Batch B-2, suggestions mode) — visual treatment for
        // pending agent-run subtrees, at the granularity lib/agent-suggestions.ts
        // ships (whole-run, not per-block): find each pending run's subtree
        // handle by BlockSuite's own `data-block-id` attribute (set on every
        // rendered block by @blocksuite/block-std's lit-host renderer — the
        // same attribute BlockSuite's own selection/range code queries
        // internally, not an internals hack) and toggle a class on it. No
        // custom block schema or BlockComponent involved — this only ever
        // touches BlockSuite's *rendered DOM*, the same boundary the
        // `.page-canvas-title`/`affine-menu` overrides in app/globals.css
        // already work within.
        const pollPendingSuggestions = async () => {
          if (cancelled) return
          const root = containerRef.current
          if (!root) return
          try {
            const suggestions = await listPendingSuggestionsForPage(pageId)
            const nextIds = new Set(suggestions.map((s) => s.subtreeBlockId))
            for (const id of appliedSuggestionBlockIds) {
              if (nextIds.has(id)) continue
              root.querySelector(`[data-block-id="${CSS.escape(id)}"]`)?.classList.remove('suggestion-pending-subtree')
              appliedSuggestionBlockIds.delete(id)
            }
            for (const id of nextIds) {
              if (appliedSuggestionBlockIds.has(id)) continue
              const el = root.querySelector(`[data-block-id="${CSS.escape(id)}"]`)
              if (el) {
                el.classList.add('suggestion-pending-subtree')
                appliedSuggestionBlockIds.add(id)
              }
            }
          } catch {
            // A later poll retries; a transient failure here must never break editing.
          }
        }
        void pollPendingSuggestions()
        suggestionsTimer = setInterval(() => void pollPendingSuggestions(), SUGGESTIONS_POLL_MS)
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
      if (suggestionsTimer) clearInterval(suggestionsTimer)
      if (doc && onUpdate) doc.spaceDoc.off('update', onUpdate)
      editor?.remove()
    }
  }, [pageId, workspaceId, workspaceSlug, initialTitle, initialDocState, locked, retryToken])

  return (
    <div>
      <div ref={containerRef} className="blocksuite-editor-root min-h-[200px] w-full" />
      {hoverInfo && hoverRect && (
        <BlockProvenanceChip
          rect={hoverRect}
          info={hoverInfo}
          workspaceSlug={workspaceSlug}
          onMouseEnter={keepOpen}
          onMouseLeave={requestClose}
        />
      )}
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
