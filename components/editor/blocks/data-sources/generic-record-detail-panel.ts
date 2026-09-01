import { html, nothing, render } from 'lit'
import { createRecordDetail, type SingleView } from '@blocksuite/data-view'
import type { UserDatabaseDataSource } from './user-database-data-source'

// NOTION-PARITY 1, requirement 5 — a lightweight sibling to
// `native-database/record-detail-panel.ts`'s `openRecordDetailPanel`, for rows
// that aren't paired to a Payload page at all (every `UserDatabaseDataSource`
// row today — relations link between these, never to Teable rows). No
// header/note slots: `createRecordDetail`'s own live property list already
// *is* the row's content for a generic database row (there's no separate
// rich-text "page" to show, unlike a Teable row's paired page), so `detail`
// is intentionally empty rather than reusing Teable's icon/cover/note slots,
// which don't apply here. Kept as a fully independent singleton (own
// container/close, not sharing state with the Teable version) since the two
// are never open from the same feature at once in practice.

let panelContainer: HTMLElement | null = null
let panelKeydownHandler: ((e: KeyboardEvent) => void) | null = null

type ReverseLink = Awaited<ReturnType<UserDatabaseDataSource['getReverseLinks']>>[number]

export function openGenericRecordDetailPanel(ops: { view: SingleView; rowId: string }) {
  closeGenericRecordDetailPanel()
  panelContainer = document.createElement('div')
  document.body.appendChild(panelContainer)

  const close = () => closeGenericRecordDetailPanel()
  const dataSource = ops.view.manager.dataSource as UserDatabaseDataSource

  const renderPanel = (reverseLinks: ReverseLink[] | 'loading') => {
    if (!panelContainer) return
    render(
      html`
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
              detail: {},
              openDoc: () => {},
            })}
            ${reverseLinks === 'loading'
              ? nothing
              : reverseLinks.length > 0
                ? html`
                    <div class="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
                      <div class="mb-2 text-xs font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                        Linked from
                      </div>
                      <div class="flex flex-col gap-1">
                        ${reverseLinks.map(
                          (link) => html`
                            <button
                              type="button"
                              class="flex items-center gap-1.5 truncate rounded px-2 py-1 text-left text-sm hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                              @click=${() => void dataSource.openRelatedRow(link.databaseId, link.rowId)}
                            >
                              <span class="truncate">${link.label}</span>
                              <span class="shrink-0 text-xs text-black/40 dark:text-white/40">— ${link.databaseName}</span>
                            </button>
                          `,
                        )}
                      </div>
                    </div>
                  `
                : nothing}
          </aside>
        </div>
      `,
      panelContainer,
    )
  }

  renderPanel('loading')
  // Reverse links computed at read time (see `UserDatabaseDataSource.getReverseLinks`)
  // — rendered once the workspace-wide scan resolves, not blocking the panel's
  // own open (the native property list above is already interactive by then).
  void dataSource
    .getReverseLinks(dataSource.databaseId, ops.rowId)
    .then((links) => renderPanel(links))
    .catch(() => renderPanel([]))

  panelKeydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', panelKeydownHandler)
}

export function closeGenericRecordDetailPanel() {
  if (!panelContainer) return
  if (panelKeydownHandler) document.removeEventListener('keydown', panelKeydownHandler)
  panelKeydownHandler = null
  panelContainer.remove()
  panelContainer = null
}
