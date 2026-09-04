// R7.4 (Roadmap A A5.1 / A5.3) — where a page came from.
//
// Most pages in this app are not created by a person clicking "new page". They
// are created *for* something: a table row gets a paired page, a task gets a
// document. Those pages are deliberately kept out of the sidebar tree (A4.2),
// which is right — they would bury it — but it left them with no visible
// context at all. Opening one, there was nothing on screen saying which table
// the row belongs to or which task the document is for, and the only way back
// was the browser's back button.
//
// This resolves that context. It is deliberately page-LEVEL and separate from
// `lib/provenance.ts`, which answers a different question (which run wrote
// which block).
import type { Payload } from 'payload'

export type PageOrigin =
  | {
      kind: 'record'
      /** The row's own title, resolved from the database's primary field —
       * never the opaque record id, which was the A4.1 bug. */
      title: string
      databaseId: number
      databaseName: string
      /** The page the table is embedded in, when one can be found. Null when
       * the database is not embedded anywhere we can see, in which case the
       * UI names the table without pretending to link to it. */
      tablePageId: number | null
    }
  | {
      kind: 'task'
      taskId: number
      taskTitle: string
      projectId: number | null
      projectName: string | null
    }
  | null

/**
 * The row's display title, resolved the same way the table itself resolves it.
 *
 * Primary field first, then the first text-ish cell, then a stated fallback —
 * and never the record id. A title of `Record aojhfiefhh` was the original
 * complaint, and falling back to an id here would reintroduce it one layer up.
 */
function resolveRowTitle(fields: unknown, cells: unknown): string {
  const cellMap = (cells && typeof cells === 'object' ? cells : {}) as Record<string, unknown>
  const fieldList = Array.isArray(fields) ? (fields as Array<Record<string, unknown>>) : []

  const primary = fieldList.find((field) => field.isPrimary)
  const primaryValue = primary && typeof primary.id === 'string' ? cellMap[primary.id] : undefined
  if (typeof primaryValue === 'string' && primaryValue.trim()) return primaryValue.trim()
  if (typeof primaryValue === 'number') return String(primaryValue)

  for (const field of fieldList) {
    if (typeof field.id !== 'string') continue
    const value = cellMap[field.id]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return 'Untitled row'
}

/**
 * Finds the page a database is embedded in.
 *
 * There is no `databases → page` relationship, because a database is embedded
 * by a block rather than owned by a page. So this searches the pages that
 * could plausibly hold it. Bounded and best-effort: returning null and naming
 * the table without a link is a perfectly good outcome, and far better than an
 * expensive scan on every page view.
 */
async function findTablePage(payload: Payload, workspaceId: number, databaseId: number): Promise<number | null> {
  try {
    const { docs } = await payload.find({
      collection: 'pages',
      where: {
        and: [{ workspace: { equals: workspaceId } }, { linkedSourceType: { exists: false } }],
      },
      depth: 0,
      limit: 200,
      overrideAccess: true,
    })
    // The block stores the database id in the document state, so a containment
    // test on the serialised state is the cheapest honest check available
    // without loading and walking every document.
    const needle = `"userDatabaseId":${databaseId}`
    for (const page of docs) {
      const state = page.docState as { update?: unknown } | null | undefined
      const raw = state?.update
      if (typeof raw === 'string' && raw.includes(needle)) return page.id
    }
  } catch {
    // Never let a nice-to-have back link break a page render.
  }
  return null
}

export async function getPageOrigin(
  payload: Payload,
  page: { id: number; workspace: number | { id: number }; linkedSourceType?: unknown; linkedSourceId?: unknown; linkedRecordId?: unknown },
): Promise<PageOrigin> {
  const workspaceId = typeof page.workspace === 'number' ? page.workspace : page.workspace.id

  // --- A row-paired page ---
  if (page.linkedSourceType === 'user-database' && page.linkedSourceId != null && page.linkedRecordId != null) {
    const databaseId = Number(page.linkedSourceId)
    const recordId = Number(page.linkedRecordId)
    if (Number.isFinite(databaseId) && Number.isFinite(recordId)) {
      const [database, row] = await Promise.all([
        payload
          .findByID({ collection: 'databases', id: databaseId, depth: 0, overrideAccess: true, disableErrors: true })
          .catch(() => null),
        payload
          .findByID({ collection: 'database-rows', id: recordId, depth: 0, overrideAccess: true, disableErrors: true })
          .catch(() => null),
      ])
      if (database) {
        return {
          kind: 'record',
          title: resolveRowTitle(database.fields, row?.cells),
          databaseId,
          databaseName: database.name,
          tablePageId: await findTablePage(payload, workspaceId, databaseId),
        }
      }
    }
  }

  // --- A task document ---
  const tasks = await payload
    .find({
      collection: 'tasks',
      where: { page: { equals: page.id } },
      depth: 1,
      limit: 1,
      overrideAccess: true,
    })
    .catch(() => ({ docs: [] as Array<Record<string, unknown>> }))
  const task = tasks.docs[0] as
    | { id: number; title: string; project?: number | { id: number; name: string } | null }
    | undefined
  if (task) {
    const project = task.project
    return {
      kind: 'task',
      taskId: task.id,
      taskTitle: task.title,
      projectId: project == null ? null : typeof project === 'number' ? project : project.id,
      projectName: project == null || typeof project === 'number' ? null : project.name,
    }
  }

  return null
}
