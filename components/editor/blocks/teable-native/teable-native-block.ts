import { BlockComponent, type EventName, type UIEventHandler } from '@/lib/blocksuite-block-std'
import {
  DatabaseSelection,
  DataView,
  dataViewCommonStyle,
  defineUniComponent,
  renderUniLit,
  widgetPresets,
  type DataViewSelection,
  type DataViewWidgetProps,
} from '@/lib/blocksuite-data-view'
import { computed, signal } from '@preact/signals-core'
import { css, html, unsafeCSS } from 'lit'
import type { TeableNativeBlockModel, TeableNativeSourceType } from './schema'
import { TeableDataSource } from './teable-data-source'
import { PayloadDataSource } from '../data-sources/payload-data-source'
import { UserDatabaseDataSource } from '../data-sources/user-database-data-source'
import type { GenericDataSource } from '../data-sources/generic-data-source'
import { openRecordDetailPanel, closeRecordDetailPanel } from './record-detail-panel'

interface ConnectionOption {
  id: number
  name: string
  teableTableId: string
}

interface UserDatabaseOption {
  id: number
  name: string
}

/**
 * Renders BlockSuite's own native table/kanban `DataView` UI (unmodified —
 * the drag-and-drop grid/board, column headers, filter bar all come straight
 * from `@blocksuite/data-view`'s `view-presets`) against a `TeableDataSource`
 * instead of local Yjs cell storage, so the "genuinely native look" is
 * backed by real, persisted Teable data.
 *
 * Forked from `@blocksuite/blocks`' `DataViewBlockComponent`
 * (`node_modules/@blocksuite/blocks/src/data-view-block/data-view-block.ts`)
 * — same `DataView.render()` wiring, trimmed of features this app doesn't
 * have configured (peek-view service, telemetry service) and with the
 * connect/loading gate every other Teable block in this app has.
 */
export class TeableNativeBlockComponent extends BlockComponent<TeableNativeBlockModel> {
  // Kept disabled while legacy Teable blocks remain readable; all new blocks
  // must choose the native Payload/user-database source picker.
  private readonly _legacyCreationEnabled = false
  static override styles = css`
    ${unsafeCSS(dataViewCommonStyle('affine-teable-native'))}
    affine-teable-native {
      display: block;
      border-radius: 8px;
      background-color: var(--affine-background-primary-color, #fff);
      padding: 8px;
      margin: 8px -8px -8px;
    }
  `

  private _connecting = false
  private _connections: ConnectionOption[] = []
  private _creatingTable = false
  private _loading = false
  private _error: string | null = null
  private _teableTableId: string | null = null
  private _tableName = 'Untitled'
  private _titleTouched = false
  // ROADMAP P2.3/D3 — swappable across the three `GenericDataSource`
  // backends; see `_mountDataSource`/`_loadPayloadSource`/
  // `_loadUserDatabaseSource` for which concrete class ends up here.
  private _dataSource: GenericDataSource | null = null
  private _dataView = new DataView()

  // Alternate-source picker state (Payload collection / generic user
  // database) — separate from `_connecting` (Teable's own "connect an
  // existing table" list), which stays untouched.
  private _pickingSourceType: 'payload' | 'user-database' | null = null
  private _payloadCollections: string[] = []
  private _userDatabases: UserDatabaseOption[] = []
  private _newUserDatabaseName = ''

  /** `model.sourceType` is the source of truth once set; `null` means a
   * pre-P2.3 document, which is always a legacy Teable connection if it has
   * a `teableDatabaseId` at all — see `schema.ts`'s comment on `sourceType`. */
  private get _effectiveSourceType(): TeableNativeSourceType | null {
    if (this.model.sourceType) return this.model.sourceType
    if (this.model.teableDatabaseId !== null) return 'teable'
    return null
  }

  private _bindHotkey = (hotkeys: Record<string, UIEventHandler>) => {
    return { dispose: this.host.event.bindHotkey(hotkeys, { blockId: this.topContenteditableElement?.blockId ?? this.blockId }) }
  }

  private _handleEvent = (name: EventName, handler: UIEventHandler) => {
    return { dispose: this.host.event.add(name, handler, { blockId: this.blockId }) }
  }

  private _selection$ = computed(() => {
    const sel = this.selection.value.find(
      (s): s is DatabaseSelection => s.blockId === this.blockId && s instanceof DatabaseSelection,
    )
    return sel?.viewSelection
  })

  private _setSelection = (selection: DataViewSelection | undefined) => {
    this.selection.setGroup('note', selection ? [new DatabaseSelection({ blockId: this.blockId, viewSelection: selection })] : [])
  }

  private _headerWidget = defineUniComponent((props: DataViewWidgetProps) => {
    return html`
      <div style="margin-bottom: 12px; display:flex; flex-direction: column">
        <div style="display:flex;align-items:center;justify-content: space-between;gap: 12px">
          <div style="flex:1">${renderUniLit(widgetPresets.viewBar, props)}</div>
        </div>
      </div>
    `
  })

  private get _workspaceId(): string | null {
    return this.closest('[data-workspace-id]')?.getAttribute('data-workspace-id') ?? null
  }

  override connectedCallback() {
    super.connectedCallback()
    this.contentEditable = 'false'
    const sourceType = this._effectiveSourceType
    if (sourceType === 'teable' && this.model.teableDatabaseId !== null) void this._loadConnectedTable()
    else if (sourceType === 'payload' && this.model.payloadCollection) void this._loadPayloadSource(this.model.payloadCollection)
    else if (sourceType === 'user-database' && this.model.userDatabaseId !== null) void this._loadUserDatabaseSource(this.model.userDatabaseId)
  }

  override disconnectedCallback() {
    super.disconnectedCallback()
    closeRecordDetailPanel()
  }

  private get _workspaceSlug(): string | null {
    return this.closest('[data-workspace-slug]')?.getAttribute('data-workspace-slug') ?? null
  }

  private async _openConnect() {
    this._connecting = true
    this._error = null
    this.requestUpdate()
    try {
      const res = await fetch(`/api/teable-databases?workspaceId=${this._workspaceId ?? ''}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || `Server returned HTTP ${res.status} listing connections.`)
      }
      const json = await res.json()
      this._connections = json.docs ?? []
    } catch (err) {
      // Distinguish a network-level failure (fetch() itself rejected — the
      // request never reached the server, e.g. connection reset under DB
      // connection-pool pressure, which this app has hit repeatedly this
      // session under concurrent load) from a server-side error response, so
      // the actual cause is visible instead of a generic message.
      this._error =
        err instanceof TypeError
          ? `Network error reaching the server (${err.message}). If this persists, retry — the shared dev DB has hit transient connection-pool pressure under concurrent load before.`
          : err instanceof Error
            ? err.message
            : 'Could not load connections.'
    } finally {
      this.requestUpdate()
    }
  }

  /** The inline title IS the create/rename affordance (no separate "new table name" input):
   * unconnected + committed (blur/Enter) → creates a Teable table named after the title
   * (the only source that can be *created* this way — Payload/user-database connections
   * are picked or created through `_renderSourcePicker`, not typed into this field);
   * already connected + committed → renames the connected source, where that's supported. */
  private async _commitTitle() {
    const trimmed = this._tableName.trim()
    const sourceType = this._effectiveSourceType

    if (sourceType === 'teable') {
      this._tableName = trimmed || 'Untitled'
      this.requestUpdate()
      return
    }

    if (sourceType === 'user-database' && this.model.userDatabaseId !== null) {
      this._tableName = trimmed || 'Untitled'
      this.requestUpdate()
      if (trimmed) {
        void fetch(`/api/user-databases/${this.model.userDatabaseId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this._tableName }),
        })
      }
      return
    }

    if (sourceType === 'payload') {
      // A Payload-backed block is named after the collection it points at,
      // not a user-chosen label — `PayloadDataSource`'s schema is fixed
      // (see its own class comment), so there's nothing to rename server-side.
      this._tableName = trimmed || (this.model.payloadCollection ?? 'Untitled')
      this.requestUpdate()
      return
    }

    // Only actually create a table once the user has typed something — merely
    // focusing then blurring the title (e.g. to click "connect an existing
    // table" instead) must not create a stray table.
    // New blocks must use Payload/user-database sources. Existing Teable
    // documents continue through the legacy branch above, but no new table is
    // created from a title blur.
    if (!this._legacyCreationEnabled || !this._titleTouched || this._creatingTable) return

    const name = trimmed || 'Untitled'
    this._tableName = name
    const workspaceId = this._workspaceId
    if (!workspaceId) {
      this._error = 'This page has no workspace context.'
      this.requestUpdate()
      return
    }

    this._creatingTable = true
    this._loading = true
    this._error = null
    this.requestUpdate()
    try {
      const res = await fetch('/api/teable/create-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workspaceId: Number(workspaceId) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create the table.')
      this._selectConnection(json.doc)
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to create the table.'
      this._loading = false
    } finally {
      this._creatingTable = false
      this.requestUpdate()
    }
  }

  private async _renameTable(name: string) {
    if (!this._teableTableId) return
    try {
      const res = await fetch('/api/teable/rename-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teableTableId: this._teableTableId, name }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || 'Failed to rename the table.')
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to rename the table.'
      this.requestUpdate()
    }
  }

  /** Resets to the create/connect view — used by "Change table" so a stray blur-commit can't be misread as renaming the table being left behind. */
  private _changeTable() {
    this.doc.updateBlock(this.model, { teableDatabaseId: null, sourceType: null, payloadCollection: null, userDatabaseId: null })
    this._teableTableId = null
    this._dataSource = null
    this._tableName = 'Untitled'
    this._titleTouched = false
    this._pickingSourceType = null
    this._error = null
    void this._openConnect()
  }

  private _openFullPage() {
    const id = this.model.teableDatabaseId
    const slug = this._workspaceSlug
    if (id === null || !slug) return
    window.location.href = `/workspace/${slug}/table/${id}`
  }

  private _selectConnection(conn: ConnectionOption) {
    this.doc.updateBlock(this.model, { teableDatabaseId: conn.id, sourceType: 'teable', payloadCollection: null, userDatabaseId: null })
    this._connecting = false
    this._teableTableId = conn.teableTableId
    this._tableName = conn.name || 'Untitled'
    this._error = null
    void this._mountDataSource()
  }

  private async _loadConnectedTable() {
    const id = this.model.teableDatabaseId
    if (id === null) return
    this._loading = true
    this._error = null
    this.requestUpdate()
    try {
      const connRes = await fetch(`/api/teable-databases/${id}`)
      const connJson = await connRes.json()
      if (!connRes.ok) throw new Error(connJson.error || 'Connection not found.')
      this._teableTableId = connJson.doc.teableTableId
      this._tableName = connJson.doc.name || 'Untitled'
      await this._mountDataSource()
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load the table.'
      this._loading = false
      this.requestUpdate()
    }
  }

  private async _mountDataSource() {
    if (!this._teableTableId) return
    const source = new TeableDataSource(this._teableTableId)
    await source.refresh()
    this._dataSource = source
    this._loading = false
    this.requestUpdate()
  }

  /** Loads+mounts a `PayloadDataSource` (existing document, e.g. after reload). */
  private async _loadPayloadSource(collection: string) {
    const workspaceId = this._workspaceId
    if (!workspaceId) {
      this._error = 'This page has no workspace context.'
      this.requestUpdate()
      return
    }
    this._loading = true
    this._error = null
    this._tableName = collection
    this.requestUpdate()
    try {
      const source = new PayloadDataSource(collection, Number(workspaceId))
      await source.refresh()
      this._dataSource = source
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load the collection.'
    } finally {
      this._loading = false
      this.requestUpdate()
    }
  }

  /** Loads+mounts a `UserDatabaseDataSource`, fetching the real doc name (schema.ts
   * doesn't cache it on the block — the `databases` doc is the source of truth). */
  private async _loadUserDatabaseSource(id: number) {
    this._loading = true
    this._error = null
    this.requestUpdate()
    try {
      const res = await fetch(`/api/user-databases/${id}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Database not found.')
      this._tableName = json.doc?.name || 'Untitled'
      const source = new UserDatabaseDataSource(id)
      await source.refresh()
      this._dataSource = source
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load the database.'
    } finally {
      this._loading = false
      this.requestUpdate()
    }
  }

  private async _openPayloadPicker() {
    this._pickingSourceType = 'payload'
    this._error = null
    this.requestUpdate()
    try {
      const res = await fetch('/api/payload-datasource')
      const json = await res.json()
      this._payloadCollections = (json.collections ?? []).map((c: { slug: string }) => c.slug)
    } catch {
      this._error = 'Could not load available collections.'
    } finally {
      this.requestUpdate()
    }
  }

  private async _openUserDatabasePicker() {
    this._pickingSourceType = 'user-database'
    this._error = null
    this.requestUpdate()
    const workspaceId = this._workspaceId
    if (!workspaceId) {
      this._error = 'This page has no workspace context.'
      this.requestUpdate()
      return
    }
    try {
      const res = await fetch(`/api/user-databases?workspaceId=${workspaceId}`)
      const json = await res.json()
      this._userDatabases = (json.docs ?? []).map((d: { id: number; name: string }) => ({ id: d.id, name: d.name }))
    } catch {
      this._error = 'Could not load user databases.'
    } finally {
      this.requestUpdate()
    }
  }

  private _selectPayloadCollection(slug: string) {
    this.doc.updateBlock(this.model, { sourceType: 'payload', payloadCollection: slug, teableDatabaseId: null, userDatabaseId: null })
    this._pickingSourceType = null
    void this._loadPayloadSource(slug)
  }

  private _selectUserDatabase(option: UserDatabaseOption) {
    this.doc.updateBlock(this.model, { sourceType: 'user-database', userDatabaseId: option.id, teableDatabaseId: null, payloadCollection: null })
    this._pickingSourceType = null
    this._tableName = option.name
    void this._loadUserDatabaseSource(option.id)
  }

  private async _createUserDatabase() {
    const workspaceId = this._workspaceId
    const name = this._newUserDatabaseName.trim() || 'Untitled'
    if (!workspaceId) {
      this._error = 'This page has no workspace context.'
      this.requestUpdate()
      return
    }
    try {
      const res = await fetch('/api/user-databases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workspaceId: Number(workspaceId) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create the database.')
      this._selectUserDatabase({ id: json.doc.id, name: json.doc.name })
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to create the database.'
      this.requestUpdate()
    }
  }

  override renderBlock() {
    if (this._effectiveSourceType === null) return this._renderCreateOrConnect()
    if (this._loading || !this._dataSource) return this._renderLoading()
    if (this._error) return this._renderErrorState()
    return this._renderDataView()
  }

  private _renderLoading() {
    return html`<div class="my-2 rounded-lg border border-black/10 px-3 py-2.5 text-sm text-black/40 dark:border-white/10 dark:text-white/40">
      Loading…
    </div>`
  }

  private _renderErrorState() {
    return html`
      <div
        class="my-2 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-600 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-400"
      >
        <span>${this._error}</span>
        <button type="button" class="rounded px-2 py-1 text-xs hover:bg-red-100 dark:hover:bg-red-950/40" @click=${() => this._changeTable()}>Change table</button>
      </div>
    `
  }

  /** One inline title serves both creating (type a name, commit) and, once
   * connected, an "or connect an existing table" secondary option — no
   * separate "new table name" input. */
  private _renderCreateOrConnect() {
    return html`
      <div class="my-2 rounded-lg border border-black/10 p-3 dark:border-white/10">
        ${this._error ? html`<div class="mb-2 text-xs text-red-600 dark:text-red-400">${this._error}</div>` : null}
        <div class="flex items-center gap-2">
          <span class="shrink-0 text-lg">🗄️</span>
          <input
            class="min-w-0 flex-1 border-none bg-transparent text-xl font-bold outline-none"
            .value=${this._tableName}
            @input=${(e: Event) => {
              this._tableName = (e.target as HTMLInputElement).value
              this._titleTouched = true
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            @blur=${() => this._commitTitle()}
          />
        </div>
        ${this._connecting
          ? this._renderExistingList()
          : this._pickingSourceType
            ? this._renderSourcePicker()
            : html`
              <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-black/40 dark:text-white/40">
                <button type="button" class="hidden" @click=${() => this._openConnect()}>
                  Or connect an existing table…
                </button>
                <button type="button" class="hover:text-black/60 dark:hover:text-white/60" @click=${() => void this._openPayloadPicker()}>
                  Use a Payload collection…
                </button>
                <button type="button" class="hover:text-black/60 dark:hover:text-white/60" @click=${() => void this._openUserDatabasePicker()}>
                  Use a user database…
                </button>
              </div>
            `}
      </div>
    `
  }

  /** ROADMAP P2.3/D3 — picker for the two non-Teable `GenericDataSource`
   * backends, alongside Teable's own pre-existing `_renderExistingList()`. */
  private _renderSourcePicker() {
    const cancel = () => {
      this._pickingSourceType = null
      this.requestUpdate()
    }
    if (this._pickingSourceType === 'payload') {
      return html`
        <div class="mt-2 border-t border-black/10 pt-2 dark:border-white/10">
          ${this._payloadCollections.length
            ? this._payloadCollections.map(
                (slug) =>
                  html`<button
                    type="button"
                    class="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                    @click=${() => this._selectPayloadCollection(slug)}
                  >
                    ${slug}
                  </button>`,
              )
            : html`<div class="px-2 py-1 text-xs text-black/40 dark:text-white/40">No collections exposed as database sources yet.</div>`}
          <button type="button" class="mt-1 text-xs text-black/40 hover:text-black/60 dark:text-white/40 dark:hover:text-white/60" @click=${cancel}>
            Cancel
          </button>
        </div>
      `
    }
    return html`
      <div class="mt-2 border-t border-black/10 pt-2 dark:border-white/10">
        ${this._userDatabases.length
          ? this._userDatabases.map(
              (d) =>
                html`<button
                  type="button"
                  class="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                  @click=${() => this._selectUserDatabase(d)}
                >
                  ${d.name}
                </button>`,
            )
          : html`<div class="px-2 py-1 text-xs text-black/40 dark:text-white/40">No user databases in this workspace yet.</div>`}
        <div class="mt-2 flex items-center gap-1.5">
          <input
            class="min-w-0 flex-1 rounded border border-black/10 bg-transparent px-2 py-1 text-sm outline-none dark:border-white/10"
            placeholder="New database name…"
            .value=${this._newUserDatabaseName}
            @input=${(e: Event) => {
              this._newUserDatabaseName = (e.target as HTMLInputElement).value
            }}
          />
          <button
            type="button"
            class="shrink-0 rounded bg-black/[.06] px-2 py-1 text-xs hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            @click=${() => void this._createUserDatabase()}
          >
            Create
          </button>
        </div>
        <button type="button" class="mt-1 text-xs text-black/40 hover:text-black/60 dark:text-white/40 dark:hover:text-white/60" @click=${cancel}>
          Cancel
        </button>
      </div>
    `
  }

  private _renderExistingList() {
    return html`
      <div class="mt-2 border-t border-black/10 pt-2 dark:border-white/10">
        ${this._connections.length
          ? this._connections.map(
              (c) =>
                html`<button
                  type="button"
                  class="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                  @click=${() => this._selectConnection(c)}
                >
                  ${c.name}
                </button>`,
            )
          : html`<div class="px-2 py-1 text-xs text-black/40 dark:text-white/40">No other tables connected to this workspace yet.</div>`}
        <button
          type="button"
          class="mt-1 text-xs text-black/40 hover:text-black/60 dark:text-white/40 dark:hover:text-white/60"
          @click=${() => {
            this._connecting = false
            this.requestUpdate()
          }}
        >
          Cancel
        </button>
      </div>
    `
  }

  private _renderDataView() {
    const dataSource = this._dataSource!
    const sourceType = this._effectiveSourceType
    const teableTableId = this._teableTableId
    return html`
      <div>
        <div class="mb-1 flex items-center gap-1.5 px-1">
          <input
            class="min-w-0 flex-1 border-none bg-transparent text-xl font-bold outline-none"
            .value=${this._tableName}
            @input=${(e: Event) => {
              this._tableName = (e.target as HTMLInputElement).value
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            @blur=${() => this._commitTitle()}
          />
          ${sourceType === 'teable'
            ? html`<button
                type="button"
                title="Open as full page"
                class="shrink-0 rounded p-1 text-black/40 hover:bg-black/[.06] hover:text-black/70 dark:text-white/40 dark:hover:bg-white/[.08] dark:hover:text-white/70"
                @click=${() => this._openFullPage()}
              >
                ↗
              </button>`
            : null}
        </div>
        <div contenteditable="false" style="position: relative">
        ${this._dataView.render({
          virtualPadding$: signal(0),
          bindHotkey: this._bindHotkey,
          handleEvent: this._handleEvent,
          selection$: this._selection$,
          setSelection: this._setSelection,
          dataSource,
          headerWidget: this._headerWidget,
          clipboard: this.std.clipboard,
          notification: { toast: (message: string) => console.warn('[teable-native]', message) },
          eventTrace: () => {},
          detailPanelConfig: {
            openDetailPanel: (_target, data) => {
              // ROADMAP P2.3 — the real BlockSuite `RecordDetail` panel is
              // wired to Teable's row-as-page pairing (`for-teable-record`)
              // specifically; an equivalent pairing for Payload/user-database
              // rows doesn't exist yet, so this is a scoped, honest no-op for
              // those sources rather than a broken/misleading panel — same
              // "reasonable no-op, not a silent gap" precedent as
              // `TeableDataSource.rowMove`.
              if (sourceType === 'teable' && teableTableId) {
                openRecordDetailPanel({
                  view: data.view,
                  rowId: data.rowId,
                  teableTableId,
                  workspaceSlug: this._workspaceSlug,
                })
              }
              return Promise.resolve()
            },
          },
        })}
        </div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-teable-native': TeableNativeBlockComponent
  }
}
