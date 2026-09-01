import { propertyPresets, type PropertyMetaConfig, type TypeInstance } from '@/lib/blocksuite-data-view'
import type { InsertToPosition } from '@/lib/blocksuite-affine-shared'
import { signal, type ReadonlySignal } from '@preact/signals-core'
import { GenericDataSource, type GenericField, type GenericRecord } from './generic-data-source'
import { showClientError } from '@/lib/client-notify'
import { relationPropertyConfig } from './relation-property'
import { openRecordDetailPanel } from '../native-database/record-detail-panel'
import { html, nothing } from 'lit'

// ROADMAP P2.3/D4 — backs an `affine:database` block with the generic
// `databases`/`database-rows` Payload collections instead of any system
// table. Unlike `TeableDataSource` (bridging a foreign REST API's own type
// vocabulary) or `PayloadDataSource` (bridging a fixed, code-defined
// collection schema), this data source *owns* its storage format end to
// end — a field's `type` is already a BlockSuite property-preset type
// string, and cell values are stored exactly as BlockSuite hands them over
// (keyed by field id, not name). That's why most of the translation
// machinery `TeableDataSource` needs simply doesn't exist here.

async function userDbFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
}

interface DatabaseDoc {
  id: number
  name: string
  fields?: GenericField[] | null
}

interface TargetDatabaseEntry {
  fields: GenericField[]
  records: GenericRecord[]
}

export class UserDatabaseDataSource extends GenericDataSource {
  get propertyMetas(): PropertyMetaConfig[] {
    return [
      propertyPresets.textPropertyConfig,
      propertyPresets.numberPropertyConfig,
      propertyPresets.checkboxPropertyConfig,
      propertyPresets.selectPropertyConfig,
      propertyPresets.multiSelectPropertyConfig,
      propertyPresets.datePropertyConfig,
      relationPropertyConfig,
    ] as PropertyMetaConfig[]
  }

  // NOTION-PARITY 1 — cache of other databases' fields+rows, populated
  // lazily by `loadTargetDatabase` as relation cells need them (a relation
  // field points at a database this data source doesn't otherwise load at
  // all). Signal-backed so cell renderers (which extend `SignalWatcher`)
  // re-render automatically once an async load resolves.
  private readonly _targetDatabaseCache = signal<Map<number, TargetDatabaseEntry>>(new Map())

  get targetDatabaseCache$(): ReadonlySignal<Map<number, TargetDatabaseEntry>> {
    return this._targetDatabaseCache
  }

  // NOTION-PARITY 7 — mutable (not `readonly` like before): a data source
  // constructed via `createOptimistic` starts with no real id at all, and
  // gets one once its background creation POST resolves (see `create()`).
  // Every method below reads `this._databaseId` live at call time rather
  // than closing over it, so reassignment here is picked up everywhere.
  private _databaseId: number | null
  private _databaseName = 'Untitled'
  private _creating$ = signal(false)

  get creating$(): ReadonlySignal<boolean> {
    return this._creating$
  }

  constructor(
    databaseId: number | null,
    private readonly _workspaceId: number,
  ) {
    super()
    this._databaseId = databaseId
  }

  /** Public for `openRelatedRow`'s reverse-link lookup, which needs to know
   * which database the row it's showing actually belongs to. `null` only
   * while an optimistic creation is still in flight — see `creating$`. */
  get databaseId(): number | null {
    return this._databaseId
  }

  /**
   * NOTION-PARITY 7 — instant slash-database creation. Returns a fully
   * usable data source *synchronously* (seeded locally with the same
   * default primary field the server seeds new databases with — see
   * `app/api/user-databases/route.ts` POST handler's own comment — so
   * there's no visible flash when the optimistic shell reconciles with the
   * real response) and fires the real `POST /api/user-databases` in the
   * background. `onCreated` fires once the real id is known, so the caller
   * (the block component) can persist it onto the block's own model —
   * without that, reloading the page would have no way to reconnect to the
   * same database and would look like the table vanished.
   */
  static createOptimistic(workspaceId: number, name: string, onCreated: (databaseId: number) => void): UserDatabaseDataSource {
    const source = new UserDatabaseDataSource(null, workspaceId)
    source._databaseName = name
    source._creating$.value = true
    const primaryFieldId = `field-${crypto.randomUUID()}`
    source._fields.value = [{ id: primaryFieldId, name: 'Name', type: 'text', isPrimary: true }]
    source._records.value = []
    // This data source deliberately never calls `refresh()` (the whole point
    // is rendering before any network round-trip) — `refresh()` is the only
    // other place `_viewData` gets seeded, so without this call there would
    // be no table/kanban view for `DataView.render()` to show at all.
    source._seedViewDataIfNeeded()
    void userDbFetch('/api/user-databases', {
      method: 'POST',
      body: JSON.stringify({ name, workspaceId }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to create the database.')
        const json = await res.json()
        if (!json?.doc?.id) throw new Error('Server did not return the created database.')
        source._databaseId = json.doc.id
        // Reconcile with whatever the server actually persisted (field ids
        // in particular — using the LOCALLY-generated ones above would
        // silently diverge from what's now the source of truth in Postgres).
        if (Array.isArray(json.doc.fields) && json.doc.fields.length > 0) {
          source._fields.value = json.doc.fields
        }
        onCreated(json.doc.id)
      })
      .catch((err) => {
        console.error('[data-source] optimistic database creation failed', err)
        showClientError("Couldn't create the database. Check your connection and try again.")
      })
      .finally(() => {
        source._creating$.value = false
      })
    return source
  }

  protected async fetchFields(): Promise<GenericField[]> {
    if (this._databaseId == null) return this._fields.value
    const res = await userDbFetch(`/api/user-databases/${this._databaseId}`)
    const json = await res.json().catch(() => null)
    const doc = json?.doc as DatabaseDoc | undefined
    if (doc?.name) this._databaseName = doc.name
    return Array.isArray(doc?.fields) ? doc!.fields! : []
  }

  protected async fetchRecords(): Promise<GenericRecord[]> {
    if (this._databaseId == null) return this._records.value
    const res = await userDbFetch(`/api/user-databases/${this._databaseId}/rows`)
    const json = await res.json().catch(() => ({ docs: [] }))
    const docs: { id: number; cells?: Record<string, unknown> | null }[] = Array.isArray(json.docs) ? json.docs : []
    return docs.map((d) => ({ id: String(d.id), fields: d.cells ?? {} }))
  }

  /** Resolves once this database's own optimistic creation POST (see
   * `createOptimistic`) has landed a real id — immediately if it already
   * has one. Used by writes that need a real id in a URL (rows, cells)
   * rather than the batched `fields` PATCH, which just re-queues itself. */
  private async _waitForDatabaseId(): Promise<number> {
    if (this._databaseId != null) return this._databaseId
    return new Promise((resolve) => {
      const check = () => {
        if (this._databaseId != null) resolve(this._databaseId)
        else setTimeout(check, 50)
      }
      check()
    })
  }

  protected getPrimaryFieldId(fields: GenericField[]): string | undefined {
    // No foreign "primary field" concept to read here (unlike Teable) — the
    // first defined property is a reasonable default for the hover-expand
    // title column, same fallback `TeableDataSource` uses when Teable's own
    // `isPrimary` flag is absent.
    return fields[0]?.id
  }

  /** Fires a debounced PATCH of the *whole* `fields` array — every property
   * mutation (add/delete/rename/retype) boils down to this, since the schema
   * lives as one JSON blob on the `databases` doc (see `collections/Databases.ts`). */
  private _persistFields() {
    this._debouncedCall('fields', 300, () => {
      // The database's own creation POST (see `createOptimistic`) hasn't
      // resolved yet — vanishingly rare given it's a single lightweight
      // insert and this fires 300ms after the *last* field edit, but never
      // silently drop a write: retry shortly instead of losing it.
      if (this._databaseId == null) {
        this._persistFields()
        return
      }
      void userDbFetch(`/api/user-databases/${this._databaseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: this._fields.value }),
      })
    })
  }

  // --- relations (NOTION-PARITY 1) ------------------------------------------

  /** Every `databases` doc in this data source's workspace, for the "link to
   * database" picker (`relation-property.ts`'s `_pickTargetDatabase`). */
  async listDatabases(): Promise<{ id: number; name: string }[]> {
    const res = await userDbFetch(`/api/user-databases?workspaceId=${this._workspaceId}`)
    const json = await res.json().catch(() => ({ docs: [] }))
    // Deliberately includes this data source's own database — self-reference
    // is a legitimate relation (e.g. a "parent task" field on `tasks` itself).
    return Array.isArray(json.docs) ? json.docs : []
  }

  /** Fetches+caches a target database's fields/rows for relation cell
   * rendering/picking. Idempotent — returns the cached entry if already
   * loaded, never refetches on every cell render. */
  async loadTargetDatabase(targetDatabaseId: number): Promise<TargetDatabaseEntry> {
    const cached = this._targetDatabaseCache.value.get(targetDatabaseId)
    if (cached) return cached
    const [fieldsRes, rowsRes] = await Promise.all([
      userDbFetch(`/api/user-databases/${targetDatabaseId}`),
      userDbFetch(`/api/user-databases/${targetDatabaseId}/rows`),
    ])
    const fieldsJson = await fieldsRes.json().catch(() => null)
    const rowsJson = await rowsRes.json().catch(() => ({ docs: [] }))
    const fields: GenericField[] = Array.isArray(fieldsJson?.doc?.fields) ? fieldsJson.doc.fields : []
    const rowDocs: { id: number; cells?: Record<string, unknown> | null }[] = Array.isArray(rowsJson.docs) ? rowsJson.docs : []
    const entry: TargetDatabaseEntry = {
      fields,
      records: rowDocs.map((d) => ({ id: String(d.id), fields: d.cells ?? {} })),
    }
    const next = new Map(this._targetDatabaseCache.value)
    next.set(targetDatabaseId, entry)
    this._targetDatabaseCache.value = next
    return entry
  }

  /** Best-effort display text for a linked row: its target database's
   * primary field value. Degrades to the raw row id if the target database
   * hasn't finished loading yet (never silently blank — same "don't let
   * content disappear" standard used for markdown export elsewhere in this
   * app) or the row was deleted since the link was made. */
  getTargetRowLabel(targetDatabaseId: number, rowId: string): string {
    const entry = this._targetDatabaseCache.value.get(targetDatabaseId)
    if (!entry) return rowId
    const row = entry.records.find((r) => r.id === rowId)
    if (!row) return `(deleted row ${rowId})`
    const primaryFieldId = entry.fields[0]?.id
    const label = primaryFieldId ? row.fields[primaryFieldId] : undefined
    return typeof label === 'string' && label.trim() ? label : 'Untitled'
  }

  /** NOTION-PARITY 1, requirement 4 — bidirectional visibility computed at
   * read time, not stored: for a row in `targetDatabaseId`, finds every OTHER
   * database in the same workspace with a relation field pointing back at
   * `targetDatabaseId`, and returns whichever of THEIR rows reference this
   * one. No reciprocal write on link/unlink — avoids write-amplification and
   * the two-sided-consistency bugs that come with it; the cost is a scan
   * across the workspace's databases on read, acceptable at this scale (a
   * single user's workspace, not a multi-tenant table). */
  async getReverseLinks(targetDatabaseId: number, rowId: string): Promise<{ databaseId: number; databaseName: string; fieldId: string; rowId: string; label: string }[]> {
    const databases = await this.listDatabases()
    const results: { databaseId: number; databaseName: string; fieldId: string; rowId: string; label: string }[] = []
    for (const db of databases) {
      const entry = await this.loadTargetDatabase(db.id)
      const relationFields = entry.fields.filter((f) => f.type === 'relation' && f.options?.targetDatabaseId === targetDatabaseId)
      if (relationFields.length === 0) continue
      const primaryFieldId = entry.fields[0]?.id
      for (const field of relationFields) {
        for (const row of entry.records) {
          const linked = row.fields[field.id]
          if (Array.isArray(linked) && linked.includes(rowId)) {
            const label = primaryFieldId ? row.fields[primaryFieldId] : undefined
            results.push({
              databaseId: db.id,
              databaseName: db.name,
              fieldId: field.id,
              rowId: row.id,
              label: typeof label === 'string' && label.trim() ? label : 'Untitled',
            })
          }
        }
      }
    }
    return results
  }

  /** Opens the real BlockSuite `RecordDetail` panel for a linked row —
   * requirement 5: same click-to-detail UX Teable's relation chips already
   * have. Builds a fresh `UserDatabaseDataSource` + its default table view
   * for the *target* database (this data source only holds its own), and
   * reuses the same generalized `openRecordDetailPanel` a direct row-click
   * in the grid already opens (real paired-page header/note, not a bare
   * property list) — plus a "Linked from" section for reverse links. */
  async openRelatedRow(targetDatabaseId: number, rowId: string): Promise<void> {
    const target = new UserDatabaseDataSource(targetDatabaseId, this._workspaceId)
    await target.refresh()
    const view = target.viewManager.viewGet('table-view')
    // Not DOM-scoped to a specific block — `document.querySelector` is a
    // pragmatic stand-in since this app mounts one editor per page; matches
    // how `RecordDetailHeader`'s "Open full page" link already degrades to a
    // no-op when unset, same posture, not a new fallback pattern.
    const workspaceSlug = document.querySelector('[data-workspace-slug]')?.getAttribute('data-workspace-slug') ?? null
    openRecordDetailPanel({
      view,
      rowId,
      sourceType: 'userDatabase',
      sourceId: String(targetDatabaseId),
      workspaceSlug,
      extraSection: async () => {
        const links = await target.getReverseLinks(targetDatabaseId, rowId)
        if (links.length === 0) return nothing
        return html`
          <div class="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
            <div class="mb-2 text-xs font-medium uppercase tracking-wide text-black/40 dark:text-white/40">Linked from</div>
            <div class="flex flex-col gap-1">
              ${links.map(
                (link) => html`
                  <button
                    type="button"
                    class="flex items-center gap-1.5 truncate rounded px-2 py-1 text-left text-sm hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                    @click=${() => void this.openRelatedRow(link.databaseId, link.rowId)}
                  >
                    <span class="truncate">${link.label}</span>
                    <span class="shrink-0 text-xs text-black/40 dark:text-white/40">— ${link.databaseName}</span>
                  </button>
                `,
              )}
            </div>
          </div>
        `
      },
    })
  }

  // --- cells --------------------------------------------------------------
  // Values are stored exactly as BlockSuite hands them over, keyed by field
  // id — no name/id or color-token translation needed, since this data
  // source owns the storage format.

  cellValueGet(rowId: string, propertyId: string): unknown {
    return this._recordById(rowId)?.fields[propertyId]
  }

  cellValueChange(rowId: string, propertyId: string, value: unknown): void {
    const record = this._recordById(rowId)
    if (!record) return
    const field = this._fieldById(propertyId)
    const previousValue = record.fields[propertyId]

    this._records.value = this._records.value.map((r) =>
      r.id === rowId ? { ...r, fields: { ...r.fields, [propertyId]: value } } : r,
    )

    this._debouncedCall(`${rowId}:${propertyId}`, 500, () => {
      void this._waitForDatabaseId().then((databaseId) =>
        userDbFetch(`/api/user-databases/${databaseId}/rows/${this._resolveRowId(rowId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ cells: { [propertyId]: value } }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
          })
          .catch((err) => {
            console.error('[data-source] cell edit failed', err)
            showClientError("Couldn't save this edit. Check your connection and try again.")
          }),
      )
    })

    // NOTION-PARITY 7 — two-way relation sync: mirror the change onto the
    // target database's real, stored mirrored field. Fires immediately
    // (not debounced with the main write above) since it's a small, targeted
    // write per *affected* target row, not a per-keystroke cost.
    if (field?.type === 'relation' && field.options?.twoWay && field.options.mirrorFieldId && field.options.targetDatabaseId) {
      const oldIds = Array.isArray(previousValue) ? (previousValue as string[]) : []
      const newIds = Array.isArray(value) ? (value as string[]) : []
      void this._syncMirror(field.options.targetDatabaseId, field.options.mirrorFieldId, rowId, oldIds, newIds)
    }
  }

  // --- rows -----------------------------------------------------------------

  rowAdd(_insertToPosition: InsertToPosition | number): string {
    // Rows are real Payload documents with a server-assigned numeric id, so
    // (unlike `propertyAdd` below) this still needs the optimistic-id/alias
    // pattern — same reasoning as `TeableDataSource.rowAdd`.
    return this._optimisticCreate<GenericRecord>({
      tempIdPrefix: 'pending-row',
      target: this._records,
      aliasMap: this._rowIdAliases,
      placeholder: { fields: {} },
      logLabel: 'rowAdd',
      create: async () => {
        const databaseId = await this._waitForDatabaseId()
        const res = await userDbFetch(`/api/user-databases/${databaseId}/rows`, {
          method: 'POST',
          body: JSON.stringify({ cells: {} }),
        })
        if (!res.ok) throw new Error('Failed to create row.')
        const json = await res.json()
        if (!json?.doc?.id) throw new Error('Server did not return the created row.')
        return { id: String(json.doc.id), fields: json.doc.cells ?? {} }
      },
    })
  }

  rowDelete(ids: string[]): void {
    this._records.value = this._records.value.filter((r) => !ids.includes(r.id))
    for (const id of ids) {
      const realId = this._resolveRowId(id)
      this._rowIdAliases.delete(id)
      if (realId === id && id.startsWith('pending-row-')) continue
      void this._waitForDatabaseId().then((databaseId) =>
        userDbFetch(`/api/user-databases/${databaseId}/rows/${realId}`, { method: 'DELETE' }),
      )
    }
  }

  // --- database name (NOTION-PARITY 7) ---------------------------------------

  /** Renames the database itself (the block's inline title, same "click,
   * type, done" affordance as a page title). Safe to call while an
   * optimistic creation is still pending — waits for the real id rather
   * than requiring the caller to know whether one exists yet. */
  rename(name: string): void {
    this._databaseName = name
    this._debouncedCall('rename', 300, () => {
      void this._waitForDatabaseId().then((databaseId) =>
        userDbFetch(`/api/user-databases/${databaseId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        }),
      )
    })
  }

  // --- properties (fields) --------------------------------------------------
  // No id-aliasing needed for fields at all: the schema is one JSON blob this
  // data source already owns, so a new field's id can be generated locally
  // and included directly in what gets persisted — there's no foreign
  // id-generator to wait on, unlike `TeableDataSource.propertyAdd`. This is
  // the concrete example `_optimisticCreate`'s own doc comment points at.

  propertyNameSet(propertyId: string, name: string): void {
    const field = this._fieldById(propertyId)
    if (!field) return
    this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, name } : f))
    this._persistFields()
  }

  propertyTypeGet(propertyId: string): string {
    return this._fieldById(propertyId)?.type ?? 'text'
  }

  propertyTypeSet(propertyId: string, toType: string): void {
    const field = this._fieldById(propertyId)
    if (!field) return
    const isSelect = toType === 'select' || toType === 'multi-select'
    const wasSelect = field.type === 'select' || field.type === 'multi-select'
    const isRelation = toType === 'relation'
    // NOTION-PARITY 7 — field-lifecycle: converting a two-way relation field
    // to a different type no longer makes it a relation at all, so the real
    // mirrored field it created on the target database is orphaned unless
    // removed — same cleanup `propertyDelete` does.
    if (field.type === 'relation' && !isRelation && field.options?.twoWay && field.options.mirrorFieldId && field.options.targetDatabaseId) {
      void this._removeMirrorField(field.options.targetDatabaseId, field.options.mirrorFieldId)
    }
    this._fields.value = this._fields.value.map((f) =>
      f.id === propertyId
        ? {
            ...f,
            type: toType,
            options: isSelect
              ? { choices: wasSelect ? (f.options?.choices ?? []) : [] }
              : isRelation
                // No `targetDatabaseId` yet — `RelationCellEditing` prompts to
                // pick one on first edit (unless retyping an existing relation
                // field, which keeps whatever it already pointed at).
                ? { targetDatabaseId: f.options?.targetDatabaseId, cardinality: f.options?.cardinality ?? 'many' }
                : undefined,
          }
        : f,
    )
    this._persistFields()
  }

  propertyDataGet(propertyId: string): Record<string, unknown> {
    const field = this._fieldById(propertyId)
    if (!field) return {}
    if (field.type === 'select' || field.type === 'multi-select') {
      return { options: (field.options?.choices ?? []).map((c) => ({ id: c.id, value: c.name, color: c.color })) }
    }
    if (field.type === 'relation') {
      return {
        targetDatabaseId: field.options?.targetDatabaseId,
        cardinality: field.options?.cardinality ?? 'many',
        twoWay: field.options?.twoWay ?? false,
        mirrorFieldId: field.options?.mirrorFieldId,
      }
    }
    return {}
  }

  propertyDataSet(propertyId: string, data: Record<string, unknown>): void {
    const field = this._fieldById(propertyId)
    if (!field) return
    if (field.type === 'select' || field.type === 'multi-select') {
      const options = data.options as Array<{ id?: string; value: string; color?: string }> | undefined
      if (!options) return
      const choices = options.map((o, i) => ({ id: o.id || `choice-${Date.now()}-${i}`, name: o.value, color: o.color ?? 'grey' }))
      this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, options: { choices } } : f))
      this._persistFields()
      return
    }
    if (field.type === 'relation') {
      // Merges onto the existing options rather than replacing wholesale —
      // `twoWay`/`mirrorFieldId` are owned by `setRelationTwoWay`, not this
      // generic path, and must survive a plain target/cardinality edit.
      const targetDatabaseId = typeof data.targetDatabaseId === 'number' ? data.targetDatabaseId : field.options?.targetDatabaseId
      const cardinality = data.cardinality === 'one' ? 'one' : 'many'
      this._fields.value = this._fields.value.map((f) =>
        f.id === propertyId ? { ...f, options: { ...f.options, targetDatabaseId, cardinality } } : f,
      )
      this._persistFields()
    }
  }

  // --- relation two-way sync (NOTION-PARITY 7) -------------------------------

  /**
   * Design: TWO-WAY creates a REAL field on the target database (a genuine
   * entry in its `fields` array, so it shows as a normal column when
   * browsing that database directly) rather than reusing the always-on
   * `getReverseLinks` computed lookup — the task explicitly wants a stored,
   * synced mirror, not just the existing "Linked from" peek. ONE-WAY is the
   * pre-existing behavior: forward-only field, no mirrored column; the
   * "Linked from" panel section still shows regardless (it's cheap, always
   * accurate, and matching Notion here — Notion shows *some* indication of
   * incoming refs even on a one-way relation's target, just without a real
   * editable property — degrading it further would hide real information
   * for no benefit).
   *
   * Turning two-way OFF (or retyping the field away from relation, see
   * `propertyTypeSet`) deletes the real mirrored field from the target
   * database — same as Notion: the forward links you already made are
   * untouched, only the synced *property* on the other side goes away.
   */
  async setRelationTwoWay(propertyId: string, enabled: boolean): Promise<void> {
    const field = this._fieldById(propertyId)
    if (!field || field.type !== 'relation' || !field.options?.targetDatabaseId) return
    const targetDatabaseId = field.options.targetDatabaseId

    if (enabled && !field.options.mirrorFieldId) {
      const mirrorFieldId = `field-${crypto.randomUUID()}`
      const target = new UserDatabaseDataSource(targetDatabaseId, this._workspaceId)
      await target.refresh()
      const mirrorField: GenericField = {
        id: mirrorFieldId,
        name: this._databaseName,
        type: 'relation',
        options: { targetDatabaseId: (await this._selfId()), cardinality: 'many', twoWay: true, mirrorFieldId: propertyId },
      }
      target._fields.value = [...target._fields.value, mirrorField]
      await target._persistFieldsNow()
      await this._backfillMirror(propertyId, mirrorFieldId, targetDatabaseId)
      this._fields.value = this._fields.value.map((f) =>
        f.id === propertyId ? { ...f, options: { ...f.options, twoWay: true, mirrorFieldId } } : f,
      )
      this._persistFields()
    } else if (!enabled && field.options.mirrorFieldId) {
      await this._removeMirrorField(targetDatabaseId, field.options.mirrorFieldId)
      this._fields.value = this._fields.value.map((f) =>
        f.id === propertyId ? { ...f, options: { ...f.options, twoWay: false, mirrorFieldId: undefined } } : f,
      )
      this._persistFields()
    }
  }

  /** This database's own id, waiting for an in-flight optimistic creation if
   * necessary — the mirror field needs a real `targetDatabaseId` to point
   * back at, and two-way setup could theoretically be triggered in the
   * brief window before `createOptimistic`'s POST resolves. */
  private async _selfId(): Promise<number> {
    return this._waitForDatabaseId()
  }

  /** Immediate (non-debounced) `fields` PATCH — used when a caller needs the
   * write durable before doing something else (backfilling mirror cells),
   * unlike the batched, fire-and-forget `_persistFields()`. */
  private async _persistFieldsNow(): Promise<void> {
    const databaseId = await this._waitForDatabaseId()
    await userDbFetch(`/api/user-databases/${databaseId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: this._fields.value }),
    })
  }

  /** One-time sync when two-way is first enabled: every row in *this*
   * database that already links to a target row needs that link mirrored
   * onto the target row's new field immediately, not just future edits. */
  private async _backfillMirror(sourceFieldId: string, mirrorFieldId: string, targetDatabaseId: number): Promise<void> {
    const byTarget = new Map<string, string[]>()
    for (const row of this._records.value) {
      const linked = row.fields[sourceFieldId]
      if (!Array.isArray(linked)) continue
      for (const targetRowId of linked) {
        const list = byTarget.get(targetRowId) ?? []
        list.push(row.id)
        byTarget.set(targetRowId, list)
      }
    }
    await Promise.all(
      Array.from(byTarget.entries()).map(([targetRowId, sourceRowIds]) =>
        userDbFetch(`/api/user-databases/${targetDatabaseId}/rows/${targetRowId}`, {
          method: 'PATCH',
          body: JSON.stringify({ cells: { [mirrorFieldId]: sourceRowIds } }),
        }),
      ),
    )
    // Drop the cache entry (if any) so the next read picks up the backfilled values.
    const next = new Map(this._targetDatabaseCache.value)
    next.delete(targetDatabaseId)
    this._targetDatabaseCache.value = next
  }

  /** Deletes a real mirrored field from a target database — used both when
   * two-way is toggled off and when the source field itself is deleted or
   * retyped away from relation. */
  private async _removeMirrorField(targetDatabaseId: number, mirrorFieldId: string): Promise<void> {
    const target = new UserDatabaseDataSource(targetDatabaseId, this._workspaceId)
    await target.refresh()
    if (!target._fields.value.some((f) => f.id === mirrorFieldId)) return
    target._fields.value = target._fields.value.filter((f) => f.id !== mirrorFieldId)
    await target._persistFieldsNow()
  }

  /** Per-edit sync while two-way is enabled: mirrors the *diff* (added/removed
   * target row ids) onto each affected target row's real mirror field,
   * reading that row fresh first (not the possibly-stale cache) since the
   * PATCH route merges at the `cells` level, not per-array-item — a stale
   * read-modify-write here would silently drop a concurrent link from
   * another row. Acceptable-scale tradeoff already established elsewhere in
   * this file: no cross-request locking, matches the single-workspace scope
   * this whole data source targets. */
  private async _syncMirror(targetDatabaseId: number, mirrorFieldId: string, sourceRowId: string, oldIds: string[], newIds: string[]): Promise<void> {
    const added = newIds.filter((id) => !oldIds.includes(id))
    const removed = oldIds.filter((id) => !newIds.includes(id))
    const affected = [...new Set([...added, ...removed])]
    if (affected.length === 0) return
    await Promise.all(
      affected.map(async (targetRowId) => {
        const res = await userDbFetch(`/api/user-databases/${targetDatabaseId}/rows/${targetRowId}`)
        const json = await res.json().catch(() => null)
        if (!res.ok || !json?.doc) return // target row may have been deleted concurrently — nothing to sync onto
        const current: string[] = Array.isArray(json.doc.cells?.[mirrorFieldId]) ? json.doc.cells[mirrorFieldId] : []
        const next = new Set(current)
        if (added.includes(targetRowId)) next.add(sourceRowId)
        if (removed.includes(targetRowId)) next.delete(sourceRowId)
        await userDbFetch(`/api/user-databases/${targetDatabaseId}/rows/${targetRowId}`, {
          method: 'PATCH',
          body: JSON.stringify({ cells: { [mirrorFieldId]: [...next] } }),
        })
      }),
    )
    // Invalidate the cache entry so any open relation cell pointed at this
    // target database picks up the mirrored change on its next interaction.
    const next = new Map(this._targetDatabaseCache.value)
    next.delete(targetDatabaseId)
    this._targetDatabaseCache.value = next
  }

  propertyDataTypeGet(propertyId: string): TypeInstance | undefined {
    const field = this._fieldById(propertyId)
    if (!field) return undefined
    const meta = this.propertyMetaGet(field.type)
    return meta?.config.type?.({ data: this.propertyDataGet(propertyId), dataSource: this })
  }

  propertyAdd(_insertToPosition: InsertToPosition, type?: string): string {
    const id = `field-${crypto.randomUUID()}`
    const newField: GenericField = { id, name: this._newPropertyName(), type: type ?? 'text' }
    this._fields.value = [...this._fields.value, newField]
    this._persistFields()
    return id
  }

  propertyDelete(id: string): void {
    const field = this._fieldById(id)
    // NOTION-PARITY 7 — field-lifecycle: deleting a two-way relation field
    // also removes the real mirrored field it created on the target
    // database, same as Notion (the forward links themselves are gone
    // either way once this property is deleted; leaving an orphaned,
    // permanently-frozen mirror column on the other side would be worse
    // than removing it).
    if (field?.type === 'relation' && field.options?.twoWay && field.options.mirrorFieldId && field.options.targetDatabaseId) {
      void this._removeMirrorField(field.options.targetDatabaseId, field.options.mirrorFieldId)
    }
    this._fields.value = this._fields.value.filter((f) => f.id !== id)
    this._persistFields()
  }

  propertyDuplicate(propertyId: string): string {
    const field = this._fieldById(propertyId)
    if (!field) throw new Error(`Property ${propertyId} not found`)
    const id = `field-${crypto.randomUUID()}`
    const index = this._fields.value.findIndex((f) => f.id === propertyId)
    const copy: GenericField = { ...field, id, name: `${field.name} copy` }
    const list = [...this._fields.value]
    list.splice(index + 1, 0, copy)
    this._fields.value = list
    this._persistFields()
    return id
  }
}
