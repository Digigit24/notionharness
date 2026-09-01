'use client'

import { useEffect, useRef } from 'react'
import type { AffineEditorContainer } from '@/lib/blocksuite-presets'
import type { Doc } from '@/lib/blocksuite-store'
import { ensureBlockSuiteEffects as loadBlockSuiteEffects } from '@/lib/blocksuite-effects'
import { loadBlockSuiteRuntime } from '@/lib/blocksuite-runtime'

// Reuses the exact same BlockSuite bootstrapping as `BlockSuiteEditor.tsx`,
// but the doc is ephemeral (never persisted/synced back to Payload — there's
// nothing to persist, all real data lives in Teable via `TeableDataSource`)
// and seeded with exactly one `affine:embed-teable-native` block, pre-connected
// to `teableDatabaseId`. This is the "open as full page" target: the same
// native block component renders itself exactly as it does inside a regular
// document, just alone on its own page.

let effectsReady: Promise<void> | null = null
function ensureEffects() {
  if (!effectsReady) {
    effectsReady = Promise.all([
      loadBlockSuiteEffects(),
      import('@/components/editor/blocks/teable-native/effects'),
    ]).then(([, teableNativeModule]) => {
      teableNativeModule.effects()
    })
  }
  return effectsReady
}

export function TeableFullPageView({ teableDatabaseId }: { teableDatabaseId: number }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let editor: AffineEditorContainer | null = null
    let doc: Doc | null = null

    async function mount() {
      await ensureEffects()
      if (cancelled) return

      const [{ presets, store, schemas, blocks }, { TeableNativeBlockSchema }, { TeableNativeBlockSpec }] =
        await Promise.all([
          loadBlockSuiteRuntime(),
          import('@/components/editor/blocks/teable-native/schema'),
          import('@/components/editor/blocks/teable-native/spec'),
        ])
      const { AffineEditorContainer } = presets
      const { DocCollection, Schema } = store
      const { AffineSchemas } = schemas
      const { PageEditorBlockSpecs } = blocks
      if (cancelled) return

      const schema = new Schema().register(AffineSchemas).register([TeableNativeBlockSchema])
      const collection = new DocCollection({ schema })
      collection.meta.initialize()
      doc = collection.createDoc({ id: `teable-fullpage-${teableDatabaseId}` })

      doc.load(() => {
        const rootId = doc!.addBlock('affine:page', {})
        doc!.addBlock('affine:surface', {}, rootId)
        const noteId = doc!.addBlock('affine:note', {}, rootId)
        doc!.addBlock('affine:embed-teable-native', { teableDatabaseId }, noteId)
      })

      editor = new AffineEditorContainer()
      editor.pageSpecs = [...PageEditorBlockSpecs, ...TeableNativeBlockSpec]
      editor.doc = doc
      editor.mode = 'page'
      editor.style.display = 'block'
      editor.style.width = '100%'

      containerRef.current?.replaceChildren(editor)
    }

    void mount()

    return () => {
      cancelled = true
      editor?.remove()
    }
  }, [teableDatabaseId])

  return <div ref={containerRef} className="blocksuite-editor-root min-h-[200px] w-full" />
}
