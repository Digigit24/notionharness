'use client'

import { useEffect, useRef } from 'react'
import { syncPageDoc } from '@/app/(app)/actions'
import type { AffineEditorContainer } from '@blocksuite/presets'
import type { Doc } from '@blocksuite/store'

const AUTOSAVE_DELAY_MS = 500

let blockSuiteEffectsReady: Promise<void> | null = null

// BlockSuite's custom elements can only be registered once per page, in the browser.
function ensureBlockSuiteEffects() {
  if (!blockSuiteEffectsReady) {
    blockSuiteEffectsReady = Promise.all([
      import('@blocksuite/blocks/effects'),
      import('@blocksuite/presets/effects'),
    ]).then(([blocksModule, presetsModule]) => {
      blocksModule.effects()
      presetsModule.effects()
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
  initialTitle,
  initialDocState,
  locked,
}: {
  pageId: number
  initialTitle: string
  initialDocState: unknown
  locked: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let editor: AffineEditorContainer | null = null
    let doc: Doc | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let onUpdate: (() => void) | null = null

    async function mount() {
      await ensureBlockSuiteEffects()
      if (cancelled) return

      const [{ AffineEditorContainer }, { DocCollection, Schema, Text }, { AffineSchemas }] = await Promise.all([
        import('@blocksuite/presets'),
        import('@blocksuite/store'),
        import('@blocksuite/blocks/schemas'),
      ])
      if (cancelled) return

      const schema = new Schema().register(AffineSchemas)
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
      editor.doc = doc
      editor.mode = 'page'
      editor.style.display = 'block'
      editor.style.width = '100%'

      containerRef.current?.replaceChildren(editor)

      onUpdate = () => {
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          if (!doc) return
          const update = DocCollection.Y.encodeStateAsUpdate(doc.spaceDoc)
          void syncPageDoc(pageId, updateToBase64(update))
        }, AUTOSAVE_DELAY_MS)
      }
      doc.spaceDoc.on('update', onUpdate)
    }

    void mount()

    return () => {
      cancelled = true
      if (saveTimer) clearTimeout(saveTimer)
      if (doc && onUpdate) doc.spaceDoc.off('update', onUpdate)
      editor?.remove()
    }
  }, [pageId, initialTitle, initialDocState, locked])

  return <div ref={containerRef} className="blocksuite-editor-root min-h-[200px] w-full" />
}
