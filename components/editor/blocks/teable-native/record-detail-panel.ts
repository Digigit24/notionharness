import { html, render } from 'lit'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRecordDetail, type DetailSlotProps, type SingleView, type UniComponent } from '@/lib/blocksuite-data-view'
import { RecordDetailHeader } from './record-detail-header'
import { RecordDetailNote } from './record-detail-note'

/**
 * Mounts a React component as a `createRecordDetail` slot: each fresh mount
 * (BlockSuite's own `keyed(rowId, ...)` recreates the slot's host element on
 * every row change — see `detail.js`) gets its own React root, matching the
 * "fresh mount per record" behavior the old `record-page-drawer.tsx` already
 * had. `rowId`/`openDoc` come from BlockSuite itself; everything else is
 * bound in the closure below.
 */
function reactSlot<ExtraProps extends object>(
  Component: (props: ExtraProps & { recordId: string; openDoc: (docId: string) => void }) => ReactElement | null,
  extraProps: ExtraProps,
): UniComponent<DetailSlotProps> {
  return (ele, initialProps) => {
    const container = document.createElement('div')
    ele.append(container)
    const root: Root = createRoot(container)
    // `RecordDetail.render()` builds a fresh `props` object literal on every
    // one of its own re-renders (e.g. a property being added/edited), not
    // just on row change, so `update()` can fire far more often than just
    // prev/next — always re-render from it rather than only at mount.
    const update = (props: DetailSlotProps) => {
      root.render(createElement(Component, { ...extraProps, recordId: props.rowId, openDoc: props.openDoc }))
    }
    update(initialProps)
    return {
      update,
      unmount: () => {
        root.unmount()
        container.remove()
      },
      expose: {},
    }
  }
}

let panelContainer: HTMLElement | null = null
let panelKeydownHandler: ((e: KeyboardEvent) => void) | null = null

export function openRecordDetailPanel(ops: {
  view: SingleView
  rowId: string
  teableTableId: string
  workspaceSlug: string | null
}) {
  closeRecordDetailPanel()
  panelContainer = document.createElement('div')
  document.body.appendChild(panelContainer)

  const close = () => closeRecordDetailPanel()

  const header = reactSlot(RecordDetailHeader, { teableTableId: ops.teableTableId, workspaceSlug: ops.workspaceSlug })
  const note = reactSlot(RecordDetailNote, { teableTableId: ops.teableTableId })

  const template = html`
    <div
      class="fixed inset-0 z-50 bg-black/20 dark:bg-black/50"
      @mousedown=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <aside
        class="ml-auto flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-black/10 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#252525]"
      >
        <button
          type="button"
          class="self-end text-xl text-black/40 hover:text-black dark:text-white/40 dark:hover:text-white"
          aria-label="Close"
          @click=${close}
        >
          ×
        </button>
        ${createRecordDetail({
          view: ops.view,
          rowId: ops.rowId,
          detail: { header, note },
          // BlockSuite's own stock `NoteRenderer` calls `openDoc(id)` after
          // creating+linking a fresh doc, to "open" it — we don't use that
          // flow (our note slot always shows real, already-paired content),
          // but the header's "Open full page" button reuses the same
          // already-threaded callback to navigate to this row's paired page.
          openDoc: (docId: string) => {
            if (!ops.workspaceSlug) return
            close()
            window.location.href = `/workspace/${ops.workspaceSlug}/p/${docId}`
          },
        })}
      </aside>
    </div>
  `

  render(template, panelContainer)

  panelKeydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', panelKeydownHandler)
}

export function closeRecordDetailPanel() {
  if (!panelContainer) return
  if (panelKeydownHandler) document.removeEventListener('keydown', panelKeydownHandler)
  panelKeydownHandler = null
  // Removing the container detaches all descendant custom elements
  // (`affine-data-view-record-detail`, `uni-lit`), firing their
  // `disconnectedCallback`s — which is what calls our `unmount()` above and
  // tears down the React roots. No manual Lit re-render needed first.
  panelContainer.remove()
  panelContainer = null
}
