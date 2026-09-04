// R8 — artifacts: resolving, creating and filing what agents author.
//
// This module is the one place the R8.3 placement rule is implemented, so
// that the MCP server, the Artifacts section and any later caller cannot
// disagree about it. The rule, stated once:
//
//   A session bound to a project files its artifacts INTO that project, and
//   they never appear in the global list. A session with no project produces
//   loose artifacts, and the Artifacts section is exactly that list.
//   Filing is a MOVE, not a copy.
//
// Everything else here exists to keep that rule honest — in particular
// `fileArtifact`, which moves the artifact's PAGE as well, because a page
// artifact whose record says "project 3" while its page says "no project"
// would show up in the project's Artifacts list and not in its Pages tab.
import type { Payload, Where } from 'payload'

import { appendBlockToSubtree, createRunSubtree, type AgentBlockSpec } from '@/lib/agent-page-writes'
import { getChatSession } from '@/lib/broker'
import { loadDoc, getNote, type AnyBlockModel } from '@/lib/blocksuite-doc'
import { propStr, textToString } from '@/lib/blocksuite-markdown-helpers'

export type ArtifactKind = 'page' | 'html'

/**
 * An HTML artifact is a document, not a blob store. Half a megabyte is far
 * past any real generated page and still small enough that reading a list of
 * them cannot wedge a request. The cap is enforced on write rather than in
 * the column type (`html_content` is TEXT) so the error says what the limit
 * is instead of surfacing as a driver-level truncation.
 */
export const ARTIFACT_HTML_MAX_BYTES = 512 * 1024

/**
 * The shape the widened table returns at depth 0.
 *
 * This used to be reached through two `as` helpers, because `payload-types.ts`
 * still described the pre-R8 Artifact and the write payloads below could not
 * satisfy it. `generate:types` has since been re-run, so the writes are now
 * checked against the real generated types and the casts are gone; this
 * interface stays only to name the relationship fields as ids-or-objects,
 * which is what `depth: 0` actually returns and what `relId` reads.
 */
interface RawArtifactDoc {
  id: number
  name: string
  kind: ArtifactKind
  workspace: number | { id: number }
  page?: number | { id: number } | null
  pageSubtreeBlockId?: string | null
  htmlContent?: string | null
  project?: number | { id: number } | null
  session?: number | null
  run?: number | null
  createdByAgent?: number | { id: number } | null
  task?: number | { id: number } | null
  url?: string | null
  createdAt: string
  updatedAt: string
}
/** Same job as `relId` in lib/activity.ts, duplicated rather than imported so
 * this module does not pull the activity spine (and its Payload hooks) into
 * the MCP request path for the sake of six lines. */
function relId(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  if (typeof value === 'object' && 'id' in (value as { id?: unknown })) return (value as { id: number }).id
  return null
}

export interface Artifact {
  id: number
  name: string
  kind: ArtifactKind
  workspaceId: number
  pageId: number | null
  pageSubtreeBlockId: string | null
  htmlContent: string | null
  projectId: number | null
  sessionId: number | null
  runId: number | null
  createdByAgentId: number | null
  taskId: number | null
  /** Legacy P2.1 external reference; empty on anything R8 creates. */
  url: string | null
  createdAt: string
  updatedAt: string
}

function toArtifact(doc: RawArtifactDoc): Artifact {
  return {
    id: doc.id,
    name: doc.name,
    kind: doc.kind === 'html' ? 'html' : 'page',
    workspaceId: relId(doc.workspace) ?? 0,
    pageId: relId(doc.page),
    pageSubtreeBlockId: doc.pageSubtreeBlockId ?? null,
    htmlContent: doc.htmlContent ?? null,
    projectId: relId(doc.project),
    sessionId: doc.session == null ? null : Number(doc.session),
    runId: doc.run == null ? null : Number(doc.run),
    createdByAgentId: relId(doc.createdByAgent),
    taskId: relId(doc.task),
    url: doc.url ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// R8.3 — placement
// ---------------------------------------------------------------------------

/**
 * Where an artifact produced by `sessionId` belongs.
 *
 * The only input is the session's own `project_id`. A run does not carry a
 * project of its own (see `lib/broker/runs.ts` — runs reach a workspace
 * through their task, page or agent, and never through a project), so the
 * session is the authority and there is nothing to reconcile.
 *
 * Returns a null project for a session with no project, and for no session at
 * all. Both mean "loose", which is the same thing to every caller.
 */
export async function resolveSessionPlacement(
  sessionId: number | null | undefined,
): Promise<{ workspaceId: number | null; projectId: number | null; agentId: number | null }> {
  if (sessionId == null) return { workspaceId: null, projectId: null, agentId: null }
  // A session id that no longer resolves is not worth failing a tool call
  // over — the artifact simply has no placement to inherit and lands in the
  // inbox, which is the safe direction to be wrong in.
  const session = await getChatSession(sessionId).catch(() => null)
  if (!session) return { workspaceId: null, projectId: null, agentId: null }
  return { workspaceId: session.workspaceId, projectId: session.projectId, agentId: session.agentId }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateArtifactInput {
  workspaceId: number
  kind: ArtifactKind
  title: string
  /** Explicit project. When omitted the R8.3 rule derives it from the session. */
  projectId?: number | null
  sessionId?: number | null
  runId?: number | null
  agentId?: number | null
  taskId?: number | null
  /** Only for `kind: 'html'`. */
  htmlContent?: string | null
}

export interface CreatedArtifact {
  artifact: Artifact
  /**
   * Workspace-relative path that opens this artifact in the side panel.
   * Relative on purpose: this module has no reliable notion of the public
   * origin (there is no APP_URL in this project — see `lib/auth.ts`, which
   * falls back to localhost), and the HTTP callers that need an absolute URL
   * already hold the incoming `Request` and can join it themselves.
   */
  openPath: string
}

/**
 * Creates an artifact, and for `kind: 'page'` the real page behind it.
 *
 * The page is created first and the artifact second, never the reverse: an
 * artifact row pointing at a page id that failed to be created is a broken
 * card in the inbox, whereas a page with no artifact row is just an ordinary
 * page, which the product already knows how to live with.
 */
export async function createArtifact(payload: Payload, input: CreateArtifactInput): Promise<CreatedArtifact> {
  const title = input.title.trim() || 'Untitled'

  // R8.3, applied at the one moment it matters. An explicit `projectId` wins
  // (a human filing by hand, or an agent told exactly where to put it);
  // otherwise the session's project is inherited, and no session means loose.
  let projectId = input.projectId ?? null
  let agentId = input.agentId ?? null

  // An EXPLICIT project is caller-supplied and therefore untrusted: the MCP
  // `artifact_create` tool takes it straight off the wire, and a run token
  // authorises a run, not a project. Without this check an agent could name
  // any project id in the database and the artifact — and, worse, the page
  // created below with the same `project` — would be planted in another
  // workspace's project, whose Pages tab queries by project alone and does
  // not re-filter by workspace. `fileArtifact` already refuses the same move
  // after the fact; refusing it at creation is the half that was missing.
  //
  // A session-derived project is NOT re-checked: it comes from the same
  // session row that produced `workspaceId`, so it cannot disagree, and
  // paying a lookup for it would tax the common path to re-prove something
  // already true.
  if (projectId != null) {
    const project = await payload
      .findByID({ collection: 'projects', id: projectId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!project) throw new Error(`Project ${projectId} was not found.`)
    if (relId(project.workspace) !== input.workspaceId) {
      throw new Error(`Project ${projectId} belongs to a different workspace.`)
    }
  }

  // `null` means "not specified" here, not "explicitly loose": the MCP tool
  // passes `project ?? null` for an omitted argument, so inheritance has to
  // key off null and not off `undefined`.
  if (projectId == null || agentId == null) {
    const placement = await resolveSessionPlacement(input.sessionId)
    if (projectId == null) projectId = placement.projectId
    if (agentId == null) agentId = placement.agentId
  }

  if (input.kind === 'html') {
    const html = input.htmlContent ?? ''
    const bytes = Buffer.byteLength(html, 'utf8')
    if (bytes > ARTIFACT_HTML_MAX_BYTES) {
      throw new Error(`HTML artifact is ${bytes} bytes; the limit is ${ARTIFACT_HTML_MAX_BYTES}.`)
    }
  }

  let pageId: number | null = null
  if (input.kind === 'page') {
    const page = await payload.create({
      collection: 'pages',
      data: {
        title,
        workspace: input.workspaceId,
        // The page carries the project too, so the project detail page's
        // Pages tab and the artifact record can never disagree about where
        // this document lives. This pairing is the whole of R8.3 in one line.
        ...(projectId == null ? {} : { project: projectId }),
      },
      overrideAccess: true,
    })
    pageId = page.id
  }

  const created: RawArtifactDoc = await payload.create({
    collection: 'artifacts',
    data: {
      workspace: input.workspaceId,
      name: title,
      kind: input.kind,
      page: pageId,
      htmlContent: input.kind === 'html' ? (input.htmlContent ?? '') : null,
      project: projectId,
      session: input.sessionId ?? null,
      run: input.runId ?? null,
      createdByAgent: agentId,
      task: input.taskId ?? null,
    },
    depth: 0,
    overrideAccess: true,
  })

  const artifact = toArtifact(created)
  return { artifact, openPath: await artifactOpenPath(payload, artifact) }
}

/**
 * The path that opens an artifact in the R8.6 side panel: the Artifacts
 * section with `?artifact=<id>`, which renders the panel over whatever is
 * already there rather than navigating to a new route.
 */
export async function artifactOpenPath(payload: Payload, artifact: Artifact): Promise<string> {
  const workspace = await payload
    .findByID({ collection: 'workspaces', id: artifact.workspaceId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  const slug = workspace?.slug
  if (!slug) return `/artifacts?artifact=${artifact.id}`
  return `/workspace/${slug}/artifacts?artifact=${artifact.id}`
}

// ---------------------------------------------------------------------------
// Writing into a page artifact
// ---------------------------------------------------------------------------

/**
 * Appends block specs, in order, to a page artifact.
 *
 * **Every write goes through `lib/agent-page-writes.ts` and nothing here
 * touches Yjs.** That module is the only guarantee in the codebase that a run
 * can append under a block it owns and can never update or delete, and
 * reaching around it to get a nicer document shape would throw that away.
 *
 * Two consequences worth stating plainly, because they are visible in the
 * product and they are not accidents:
 *
 * 1. The content sits under one run-owned toggle block (`createRunSubtree`),
 *    even for a page the run created itself and could legitimately own
 *    whole. R8.5's second ownership mode — run owns the document, update and
 *    reorder allowed — is a change to `agent-page-writes.ts`, which this unit
 *    does not own. Until that lands this is the append-only guarantee working
 *    as designed, not a shortcut.
 * 2. `appendBlockToSubtree` loads and persists the doc per block, so a batch
 *    of N blocks is N doc round trips. That is worse than it should be for a
 *    latency-first project, and the fix is a batched append inside
 *    `agent-page-writes.ts` — again, that file, not this one. Batching is
 *    exposed here anyway (the caller sends one array) so the fix is a change
 *    of implementation and not of the tool schema.
 */
export async function appendArtifactBlocks(
  payload: Payload,
  artifactId: number,
  specs: AgentBlockSpec[],
): Promise<{ blockIds: string[]; pageId: number; subtreeBlockId: string }> {
  const artifact = await getArtifact(payload, artifactId)
  if (!artifact) throw new Error(`Artifact ${artifactId} was not found.`)
  if (artifact.kind !== 'page') {
    throw new Error(`Artifact ${artifactId} is an HTML artifact; blocks can only be appended to a page artifact.`)
  }
  if (artifact.pageId == null) {
    throw new Error(`Artifact ${artifactId} has no page. Its document was deleted.`)
  }
  const pageId = artifact.pageId

  // Lazily created, same reasoning as the daemon bridge: an artifact nobody
  // ever writes to should not carry an empty section on its page.
  let subtree = artifact.pageSubtreeBlockId
  if (!subtree) {
    subtree = await createRunSubtree(payload, pageId, artifact.name)
    await payload.update({
      collection: 'artifacts',
      id: artifactId,
      data: ({ pageSubtreeBlockId: subtree }),
      depth: 0,
      overrideAccess: true,
    })
  }

  const blockIds: string[] = []
  for (const spec of specs) {
    // Sequential, not `Promise.all`: these all mutate the same Yjs doc and
    // persist it, so running them concurrently would race the read-modify-
    // write and silently drop blocks. Order is also part of the contract.
    blockIds.push(await appendBlockToSubtree(payload, pageId, subtree, spec))
  }
  // The subtree is returned rather than left for the caller to re-read off
  // the artifact: on the FIRST append it was created a few lines above, so an
  // artifact record the caller fetched before this call still says null and
  // any event it emits would name the wrong subtree.
  return { blockIds, pageId, subtreeBlockId: subtree }
}

/**
 * A block as read back off a page. Blocks whose flavour has no
 * `AgentBlockSpec` equivalent are reported as `unsupported` rather than
 * dropped: an agent that reads a page, sees fewer blocks than are there and
 * then "revises" it would be working from a lie, so telling it that something
 * it cannot express is present is the honest failure.
 */
export type ReadBlock = (AgentBlockSpec & { id: string }) | { id: string; kind: 'unsupported'; flavour: string }

export async function readArtifactBlocks(
  payload: Payload,
  artifactId: number,
): Promise<{ artifact: Artifact; blocks: ReadBlock[]; html: string | null }> {
  const artifact = await getArtifact(payload, artifactId)
  if (!artifact) throw new Error(`Artifact ${artifactId} was not found.`)
  if (artifact.kind === 'html') return { artifact, blocks: [], html: artifact.htmlContent }
  if (artifact.pageId == null) return { artifact, blocks: [], html: null }

  const page = await payload
    .findByID({ collection: 'pages', id: artifact.pageId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!page) return { artifact, blocks: [], html: null }

  const { doc } = loadDoc(artifact.pageId, page.title || artifact.name, page.docState)
  const note = getNote(doc)
  if (!note) return { artifact, blocks: [], html: null }

  const out: ReadBlock[] = []
  const walk = (model: AnyBlockModel) => {
    for (const child of model.children) {
      out.push(describeBlock(child))
      walk(child)
    }
  }
  walk(note)
  return { artifact, blocks: out, html: null }
}

function describeBlock(model: AnyBlockModel): ReadBlock {
  const id = String(model.id ?? '')
  const text = textToString(model.text as Parameters<typeof textToString>[0])
  switch (model.flavour) {
    case 'affine:paragraph': {
      const type = propStr(model, 'type', 'text')
      if (type === 'h1') return { id, kind: 'heading', level: 1, text }
      if (type === 'h2') return { id, kind: 'heading', level: 2, text }
      if (type === 'h3') return { id, kind: 'heading', level: 3, text }
      // h4-h6 and quote collapse to a paragraph rather than being reported
      // unsupported: the text is fully recoverable, only the styling is lost,
      // and an agent that can read it can rewrite it.
      return { id, kind: 'paragraph', text }
    }
    case 'affine:list': {
      const type = propStr(model, 'type', 'bulleted')
      if (type === 'todo') return { id, kind: 'list', type: 'todo', text, checked: model.checked === true }
      if (type === 'numbered') return { id, kind: 'list', type: 'numbered', text }
      // 'toggle' included — it is a bulleted list as far as the spec goes,
      // and it is what `createRunSubtree` makes, so an artifact reading its
      // own root must not choke on it.
      return { id, kind: 'list', type: 'bulleted', text }
    }
    case 'affine:code':
      return { id, kind: 'code', text, language: propStr(model, 'language', '') || null }
    default:
      return { id, kind: 'unsupported', flavour: String(model.flavour) }
  }
}

// ---------------------------------------------------------------------------
// Reading and filing
// ---------------------------------------------------------------------------

export async function getArtifact(payload: Payload, id: number): Promise<Artifact | null> {
  const doc = await payload
    .findByID({ collection: 'artifacts', id, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  return doc ? toArtifact(doc) : null
}

export interface ListArtifactsOptions {
  workspaceId: number
  /**
   * `'loose'` is the Artifacts section: artifacts with no project. A number
   * narrows to one project. `undefined` means every artifact in the
   * workspace, which is what `artifact_list` without a project does.
   */
  project?: number | 'loose'
  sessionId?: number
  agentId?: number
  kind?: ArtifactKind
  limit?: number
}

export async function listArtifacts(payload: Payload, options: ListArtifactsOptions): Promise<Artifact[]> {
  const where: Where = { workspace: { equals: options.workspaceId } }
  if (options.project === 'loose') where.project = { exists: false }
  else if (typeof options.project === 'number') where.project = { equals: options.project }
  if (options.sessionId != null) where.session = { equals: options.sessionId }
  if (options.agentId != null) where.createdByAgent = { equals: options.agentId }
  if (options.kind) where.kind = { equals: options.kind }

  const result = await payload.find({
    collection: 'artifacts',
    where,
    // Newest first, which is the only order R8.4 asks for. Triage reads down
    // from the top and the list's job is to shrink, so there is nothing a
    // second sort would be useful for.
    sort: '-createdAt',
    limit: Math.min(Math.max(options.limit ?? 100, 1), 500),
    depth: 0,
    overrideAccess: true,
  })
  return result.docs.map((doc) => toArtifact(doc))
}

/**
 * R8.3's move. Setting `projectId` files the artifact into that project and
 * out of the inbox; passing `null` sends it back.
 *
 * The page moves with it. That is the entire reason this is a function rather
 * than a one-line `payload.update` at each call site: an artifact whose record
 * and whose page disagree about their project shows up in one of the
 * project's tabs and not the other, and the bug is invisible until someone
 * goes looking for a document they know they filed.
 */
export async function fileArtifact(payload: Payload, artifactId: number, projectId: number | null): Promise<Artifact> {
  const artifact = await getArtifact(payload, artifactId)
  if (!artifact) throw new Error(`Artifact ${artifactId} was not found.`)

  if (projectId != null) {
    // Cross-workspace filing is not a validation nicety — it would move a
    // document out of its tenancy boundary while leaving `workspace`
    // pointing at the old one.
    const project = await payload
      .findByID({ collection: 'projects', id: projectId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!project) throw new Error(`Project ${projectId} was not found.`)
    if (relId(project.workspace) !== artifact.workspaceId) {
      throw new Error(`Project ${projectId} belongs to a different workspace.`)
    }
  }

  const updated: RawArtifactDoc = await payload.update({
    collection: 'artifacts',
    id: artifactId,
    data: { project: projectId },
    depth: 0,
    overrideAccess: true,
  })

  if (artifact.pageId != null) {
    const pageId = artifact.pageId
    // Best-effort, and deliberately after the artifact write rather than
    // before: if the page update fails the artifact has still moved, which is
    // the state the human asked for and can see. The reverse — page moved,
    // artifact not — would be invisible.
    await payload
      .update({ collection: 'pages', id: pageId, data: { project: projectId }, overrideAccess: true })
      .catch((error) => {
        console.error(`Artifact ${artifactId} filed, but its page ${pageId} did not move.`, error)
      })
  }

  return toArtifact(updated)
}
