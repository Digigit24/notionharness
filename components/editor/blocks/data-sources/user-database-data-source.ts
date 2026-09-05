import { propertyPresets, type PropertyMetaConfig, type TypeInstance } from '@/lib/blocksuite-data-view'
import type { InsertToPosition } from '@/lib/blocksuite-affine-shared'
import { popupTargetFromElement, type PopupTarget } from '@/lib/blocksuite-affine-components'
import { computed, signal, type ReadonlySignal } from '@preact/signals-core'
import { GenericDataSource, type GenericField, type GenericRecord } from './generic-data-source'
import { showClientError } from '@/lib/client-notify'
import { relationPropertyConfig, openRelationConfig } from './relation-property'
import { formulaPropertyConfig, rollupPropertyConfig, openFormulaConfig, openRollupConfig } from './computed-property'
import {
  evaluateComputed,
  keyOf,
  type ComputedSpec,
  type DatabaseLike,
  type PropertyLike,
  type RollupAggregation,
} from '@/lib/database/computed'
import { toCell } from '@/lib/database/values'
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

/**
 * A locally-unique field id — never a security-sensitive value, just a key
 * BlockSuite uses to address a property. `crypto.randomUUID()` throws
 * "crypto.randomUUID is not a function" outside a secure context (HTTPS or
 * localhost) — reproduced live over a plain-HTTP Tailscale address, where
 * `window.crypto` exists but lacks the `randomUUID` method the spec only
 * exposes to secure contexts. The fallback below is an ordinary RFC-4122-
 * shaped v4 UUID built from `Math.random()`, which is exactly as suitable
 * here as the real thing — this app never uses these ids for anything that
 * needs cryptographic unpredictability.
 */
function randomFieldSuffix(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Defensive normalization for a legacy field shape found live in the shared
 * dev DB (database id 5's "QA2 Database"): a relation field stored its
 * config under a `data` key instead of `options` — `{id, data: {...},
 * name, type, isPrimary}` — which no current code path produces (every
 * `options`-reading call site here uses `field.options?.x`, so a field like
 * this just silently showed "Click to choose a database…" instead of its
 * real, already-linked target — degraded, not crashed, but wrong). Data was
 * corrected once directly; this exists so the same shape, wherever it came
 * from (hand-authored test data, a future manual DB edit), self-heals on
 * next read instead of silently misbehaving again.
 */
function normalizeLegacyField(field: GenericField): GenericField {
  const legacy = field as GenericField & { data?: Record<string, unknown> }
  if (legacy.options === undefined && legacy.data !== undefined) {
    const { data, ...rest } = legacy
    return { ...rest, options: data }
  }
  return field
}

/**
 * Finds the rendered column-header element for a property so a follow-up
 * config popup can anchor to it — same "no clean extension point, reach into
 * BlockSuite's own DOM instead" posture `native-database/slash-menu.ts`
 * documents for the slash menu, just at object- rather than string-identity:
 * `affine-database-header-column` binds `.column` as a live JS property (not
 * a reflected attribute), and it's the SAME `Property` object graph this data
 * source's own `view.propertyGet(id)` returns (one module graph app-wide —
 * see `lib/blocksuite-affine-components.ts`'s header on why that invariant
 * matters), so matching on `.column.id` is exact, not a name/text guess.
 * `document.querySelector` (not scoped to `this` block's own subtree) is the
 * same pragmatic "one editor per page" stand-in already used elsewhere in
 * this file (see `openRelatedRow`'s `[data-workspace-slug]` lookup).
 */
function findPropertyHeaderAnchor(propertyId: string): PopupTarget | null {
  if (typeof document === 'undefined') return null
  const columns = document.querySelectorAll('affine-database-header-column')
  for (const el of columns) {
    const withColumn = el as HTMLElement & { column?: { id?: string } }
    if (withColumn.column?.id === propertyId) return popupTargetFromElement(withColumn)
  }
  return null
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
      // R13-P2 - computed properties. Listed last because they are the two
      // that read the rest of the row rather than holding a value of their
      // own, and the property picker reads top to bottom.
      formulaPropertyConfig,
      rollupPropertyConfig,
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
    const primaryFieldId = `field-${randomFieldSuffix()}`
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
    // A non-OK response used to fall through to an empty field list — a
    // permission or server error looked identical to "this database
    // genuinely has no columns," and the block's own error state (with its
    // "Change table" recovery action) never got a chance to render.
    if (!res.ok) throw new Error(json?.error || `Failed to load this database's columns (HTTP ${res.status}).`)
    const doc = json?.doc as DatabaseDoc | undefined
    if (doc?.name) this._databaseName = doc.name
    return Array.isArray(doc?.fields) ? doc!.fields!.map(normalizeLegacyField) : []
  }

  protected async fetchRecords(): Promise<GenericRecord[]> {
    if (this._databaseId == null) return this._records.value
    const res = await userDbFetch(`/api/user-databases/${this._databaseId}/rows`)
    const json = await res.json().catch(() => ({ docs: [] }))
    if (!res.ok) throw new Error(json?.error || `Failed to load this database's rows (HTTP ${res.status}).`)
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

  // --- computed properties (R13-P2) ---------------------------------------
  //
  // A formula or rollup cell holds no stored value: it is derived from this
  // row, and - for a rollup - from rows in another database entirely. So the
  // values live here, recomputed as a SET rather than one cell at a time.
  //
  // Why a whole-table pass instead of computing a cell when it is drawn: a
  // formula over a rollup over a relation would otherwise resolve recursively
  // per cell, which is the read-time N+1 D0 forbids with a memo table on top.
  // `evaluateComputed` topologically sorts the properties and walks the rows
  // once, so a two-thousand-row table is one pass rather than two thousand
  // dependency resolutions.
  //
  // Signal-backed for the same reason `_targetDatabaseCache` is: cell
  // renderers extend `SignalWatcher`, so reading this inside `render()` IS the
  // subscription.
  //
  // DERIVED, not cached. `computed()` recomputes exactly when one of the
  // signals it read has changed - the fields, the rows, or the relation cache -
  // and not once otherwise. A hand-rolled cache with an explicit
  // `recomputeDerived()` was the first version of this and it was wrong in the
  // way every manual invalidation is wrong: every future edit path is a new
  // chance to forget the call, and the symptom is a stale number that looks
  // like a real one.
  private readonly _computed = computed<Map<string, Map<string, unknown>>>(() => {
    const databases = this._databasesForComputation()
    if (databases.length === 0) return new Map()
    const evaluated = evaluateComputed(databases)
    const next = new Map<string, Map<string, unknown>>()
    for (const [key, perRow] of evaluated) {
      const cells = new Map<string, unknown>()
      for (const [rowId, value] of perRow) cells.set(rowId, toCell(value))
      next.set(key, cells)
    }
    return next
  })

  /** This database plus every target database already in the relation cache.
   * A rollup whose target has not been fetched yet evaluates against no rows
   * and renders empty, then recomputes when `loadTargetDatabase` resolves -
   * which is the right order round: blocking a table's first paint on a second
   * database's fetch is exactly what D0 rules out. */
  private _databasesForComputation(): DatabaseLike[] {
    const databaseId = this._databaseId
    if (databaseId == null) return []
    const toPropertyLike = (field: GenericField): PropertyLike => ({
      id: field.id,
      name: field.name,
      type: field.type,
      options: {
        targetDatabaseId: field.options?.targetDatabaseId,
        computed: this._computedSpecOf(field),
      },
    })
    const self: DatabaseLike = {
      id: databaseId,
      properties: this._fields.value.map(toPropertyLike),
      rows: this._records.value.map((record) => ({ id: record.id, cells: record.fields })),
    }
    const targets: DatabaseLike[] = []
    for (const [id, entry] of this._targetDatabaseCache.value) {
      if (id === databaseId) continue
      targets.push({
        id,
        properties: entry.fields.map(toPropertyLike),
        rows: entry.records.map((record) => ({ id: record.id, cells: record.fields })),
      })
    }
    return [self, ...targets]
  }

  /**
   * A field's computed definition, read out of the shape the property type
   * actually stores.
   *
   * BlockSuite keeps a property's configuration in its own `data` bag, which
   * this data source persists inside `field.options`. Rather than teach
   * `lib/database` about that layout, the translation happens here - the same
   * edge-of-the-data-source translation every other backend-native shape gets
   * in this file.
   */
  private _computedSpecOf(field: GenericField): ComputedSpec | undefined {
    const options = field.options as Record<string, unknown> | undefined
    if (field.type === 'formula') {
      const expression = typeof options?.expression === 'string' ? options.expression : ''
      return expression.trim() === '' ? undefined : { kind: 'formula', expression }
    }
    if (field.type === 'rollup') {
      const relationPropertyId = typeof options?.relationPropertyId === 'string' ? options.relationPropertyId : null
      const targetPropertyId = typeof options?.targetPropertyId === 'string' ? options.targetPropertyId : null
      // An unconfigured rollup is not an error - it is one somebody has not
      // finished defining - so it computes to nothing rather than to a failure.
      if (!relationPropertyId || !targetPropertyId) return undefined
      return {
        kind: 'rollup',
        relationPropertyId,
        targetPropertyId,
        aggregation: (typeof options?.aggregation === 'string'
          ? options.aggregation
          : 'count_values') as RollupAggregation,
      }
    }
    return undefined
  }

  /** The relation properties a rollup can read through. */
  relationProperties(): Array<{ id: string; name: string; targetDatabaseId?: number }> {
    return this._fields.value
      .filter((field) => field.type === 'relation' && field.options?.targetDatabaseId != null)
      .map((field) => ({ id: field.id, name: field.name, targetDatabaseId: field.options?.targetDatabaseId }))
  }

  /** The properties on the far side of a relation, loading that database if
   * this is the first time anything has asked for it. */
  async targetPropertiesFor(relationPropertyId: string): Promise<Array<{ id: string; name: string; type: string }>> {
    const relation = this._fieldById(relationPropertyId)
    const targetDatabaseId = relation?.options?.targetDatabaseId
    if (targetDatabaseId == null) return []
    const entry = await this.loadTargetDatabase(targetDatabaseId)
    // A rollup over another computed property is legal - the dependency graph
    // orders it - so nothing is filtered out here.
    return entry.fields.map((field) => ({ id: field.id, name: field.name, type: field.type }))
  }

  // --- cells --------------------------------------------------------------
  // Values are stored exactly as BlockSuite hands them over, keyed by field
  // id — no name/id or color-token translation needed, since this data
  // source owns the storage format.

  cellValueGet(rowId: string, propertyId: string): unknown {
    // A computed property has no stored cell. Reading `fields[propertyId]` for
    // one would return whatever an older version of this code happened to
    // write there, which is worse than returning nothing.
    const field = this._fieldById(propertyId)
    if (field && (field.type === 'formula' || field.type === 'rollup')) {
      const databaseId = this._databaseId
      if (databaseId == null) return null
      return this._computed.value.get(keyOf(databaseId, propertyId))?.get(rowId) ?? null
    }
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

    if (toType === 'formula' || toType === 'rollup' || toType === 'relation') {
      this._openConfigAfterTypeChange(propertyId, toType)
    }
  }

  /**
   * property-popup — WHY this exists: BlockSuite's own property-type picker
   * (`@blocksuite/data-view`'s `core/common/property-menu.js`) calls
   * `property.typeSet?.(type)` and stops — no lifecycle hook fires after a
   * property becomes `formula`/`rollup`/`relation`, so a user picking one of
   * these from the header dropdown had no way to discover that clicking into
   * a CELL is what actually opens the real editor
   * (`FormulaCellEditing`/`RollupCellEditing`/`RelationCellEditing`'s own
   * `firstUpdated()`). `TableSingleView.propertyTypeSet` (the vendored
   * source) just forwards to `dataSource.propertyTypeSet` — this method —
   * making it the one, and only, place in this whole app that call funnels
   * through, so it's the correct extension point rather than something
   * reached for by convenience.
   *
   * Reuses the cell editors' own popup-building functions (never rewrites
   * them — see each one's own comment on why) anchored at the column's
   * HEADER, not a cell: at this moment there's no specific row in play yet,
   * so this only ever drives the column-level half of relation's flow
   * (target database + two-way), never `_pickRows` (a specific row's links).
   * `queueMicrotask` lets BlockSuite's own type-picker submenu finish
   * closing first (it closes synchronously, in the same click handler that
   * called `typeSet`, per `sub-menu.js`'s `onComplete` chain) so this app's
   * follow-up popup doesn't contend with the one being torn down.
   *
   * Select/multi-select share this exact same gap (confirmed by reading
   * `@blocksuite/data-view/property-presets/select/cell-renderer.js`:
   * `SelectCellEditing.firstUpdated()` also only opens its options editor on
   * a cell click) but aren't wired up here — their editor is `popTagSelect`,
   * an internal helper `@blocksuite/data-view` never exports from its public
   * entry points (checked: absent from `index.js`/`property-presets.js`), so
   * reaching it would mean a deep, unsupported import into vendored
   * internals, unlike formula/rollup/relation, which are this app's OWN
   * files it fully controls.
   */
  private _openConfigAfterTypeChange(propertyId: string, toType: 'formula' | 'rollup' | 'relation') {
    queueMicrotask(() => {
      const anchor = findPropertyHeaderAnchor(propertyId)
      if (!anchor) return
      const view = this.viewManager.viewGet('table-view')
      // `view.propertyGet` returns the widest `Property<unknown, Record<
      // string, unknown>>` — `Parameters<typeof openXConfig>[0]['property']`
      // (not the unexported `PropertyHandle`/`ConfigHost` types themselves,
      // which can't be named from outside `computed-property.ts`/
      // `relation-property.ts`) narrows it back to what each opener actually
      // declares, since this data source is the one that just set this exact
      // field's type and knows which shape it now has.
      if (toType === 'formula') {
        const property = view.propertyGet(propertyId) as unknown as Parameters<typeof openFormulaConfig>[0]['property']
        openFormulaConfig({ dataSource: this, property, anchor, onClose: () => undefined })
      } else if (toType === 'rollup') {
        const property = view.propertyGet(propertyId) as unknown as Parameters<typeof openRollupConfig>[0]['property']
        openRollupConfig({ dataSource: this, property, anchor, onClose: () => undefined })
      } else {
        const property = view.propertyGet(propertyId) as unknown as Parameters<typeof openRelationConfig>[0]['property']
        openRelationConfig({ dataSource: this, property, anchor, onClose: () => undefined })
      }
    })
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
    // property-popup — these two branches were MISSING entirely (this method
    // fell through to the bare `{}` below for every formula/rollup field),
    // which is why `FormulaCellEditing`/`RollupCellEditing` always reopened
    // to an empty, unconfigured state even for a field someone had already
    // filled in through this exact popup: `Property.data$` is `computed(()
    // => view.propertyDataGet(id))` (see `PropertyBase` in
    // `@blocksuite/data-view`), so whatever this returns for `expression`/
    // `relationPropertyId`/etc. IS what the popup shows as "already set."
    // `_computedSpecOf` below already read these same keys off `field.options`
    // (via a cast, since `GenericField['options']` never declared them either
    // — now fixed in `generic-data-source.ts`), so this is a read-path
    // omission, not new field names invented for this fix.
    if (field.type === 'formula') {
      return { expression: field.options?.expression ?? '' }
    }
    if (field.type === 'rollup') {
      return {
        relationPropertyId: field.options?.relationPropertyId,
        targetPropertyId: field.options?.targetPropertyId,
        aggregation: field.options?.aggregation ?? 'count_values',
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
      return
    }
    // property-popup — the actual root cause behind "I cannot configure the
    // formula or rollup [in the cell editor]": these two branches didn't
    // exist, so `FormulaCellEditing`/`RollupCellEditing` calling
    // `property.dataUpdate(...)` (see `computed-property.ts`) silently wrote
    // nothing — this method just fell through and returned. Typing an
    // expression and hitting Enter *looked* like it worked (the popup closed
    // without an error) but nothing was ever persisted to `field.options`,
    // so `_computedSpecOf` always saw an unconfigured field on the very next
    // read. Merged onto existing `options` like `relation` above, not
    // replaced wholesale, so e.g. picking a new aggregation doesn't clobber
    // an already-chosen relation/target.
    if (field.type === 'formula') {
      const expression = typeof data.expression === 'string' ? data.expression : (field.options?.expression ?? '')
      this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, options: { ...f.options, expression } } : f))
      this._persistFields()
      return
    }
    if (field.type === 'rollup') {
      // NOT falling back to `field.options?.X` the way `expression`/`relation`
      // above do: `PropertyBase.dataUpdate` (the only real caller — see
      // `@blocksuite/data-view`'s `core/view-manager/property.js`) already
      // merges the CURRENT `data$.value` with the updater's partial result
      // before calling this method, so `data` here is already the complete
      // desired state — including an explicit `targetPropertyId: undefined`
      // from `openRollupRelationPicker`'s "changing the relation invalidates
      // the target/aggregation answers" reset. Falling back to the old
      // `field.options` value here would silently UNDO that reset, keeping
      // a rollup pointed at a property in a database it no longer reads.
      const relationPropertyId = typeof data.relationPropertyId === 'string' ? data.relationPropertyId : undefined
      const targetPropertyId = typeof data.targetPropertyId === 'string' ? data.targetPropertyId : undefined
      const aggregation = typeof data.aggregation === 'string' ? data.aggregation : undefined
      this._fields.value = this._fields.value.map((f) =>
        f.id === propertyId ? { ...f, options: { ...f.options, relationPropertyId, targetPropertyId, aggregation } } : f,
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
      const mirrorFieldId = `field-${randomFieldSuffix()}`
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
    const id = `field-${randomFieldSuffix()}`
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
    const id = `field-${randomFieldSuffix()}`
    const index = this._fields.value.findIndex((f) => f.id === propertyId)
    const copy: GenericField = { ...field, id, name: `${field.name} copy` }
    const list = [...this._fields.value]
    list.splice(index + 1, 0, copy)
    this._fields.value = list
    this._persistFields()
    return id
  }
}
