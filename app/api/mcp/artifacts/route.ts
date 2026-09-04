// R8.5 — the artifact MCP server: how an agent authors a document.
//
// A separate route from `/api/mcp` rather than four more tools on it. That
// server is the task-page bridge — one run, one task page, append-only into a
// human's document — and this one is the artifact surface, where the run
// creates the document it is writing. They share auth and nothing else, and
// merging them would mean a single tool list where half the verbs error for
// any given run.
//
// Everything structural is copied from `app/api/mcp/route.ts` on purpose:
// run-token auth compared against the run's OWN token, a fresh `McpServer`
// per request, and `enableJsonResponse: true`. That last one is not a style
// choice — without it the transport streams SSE, and the per-request cleanup
// in the `finally` below tears the stream down before a byte reaches the
// client, producing a 200 with an empty body. That was observed for real; do
// not "simplify" it away.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import type { AgentBlockSpec } from '@/lib/agent-page-writes'
import {
  appendArtifactBlocks,
  createArtifact,
  getArtifact,
  listArtifacts,
  readArtifactBlocks,
  ARTIFACT_HTML_MAX_BYTES,
} from '@/lib/artifacts'
import { appendRunEvent } from '@/lib/broker/messages'
import { getChatSession } from '@/lib/broker'
import { getRun } from '@/lib/broker/runs'
import { getPayloadClient } from '@/lib/payload'
import type { Run } from '@/lib/broker/types'

export const dynamic = 'force-dynamic'
// Postgres and BlockSuite are both Node-only; neither runs on the edge.
export const runtime = 'nodejs'

/**
 * R8.7 — "rate limit blocks per turn with a hard ceiling. A looping agent
 * must not be able to write a ten thousand block document."
 *
 * Process-local, and that is a real limitation rather than a design: the
 * durable place for this counter is the `runs` row, and `lib/broker/runs.ts`
 * plus its migrations are outside this unit's owned files. In the deployment
 * this app actually has (one Next server) the counter is effectively the
 * whole truth; behind more than one instance a determined loop gets the
 * ceiling once per instance. It is a guard, not a guarantee, and it is
 * labelled as one so nobody later mistakes it for the latter.
 *
 * The map is keyed by run and never swept, which is fine because a run is
 * bounded and short-lived; a process that outlives enough runs to make this
 * matter has bigger problems than a few integers.
 */
const MAX_BLOCKS_PER_RUN = 2_000
const blocksWrittenByRun = new Map<number, number>()

function jsonResult(value: unknown) {
  // MCP content is text; structured results go back as JSON in a text block,
  // which is what every client in this codebase already expects to parse.
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
  }
}

/**
 * The workspace a run authors into.
 *
 * Runs carry no workspace column (see `listActiveRunsForWorkspace` in
 * `lib/broker/runs.ts`, which joins three ways for the same reason). The
 * session is tried first because it is also the source of the R8.3 placement
 * rule, so when it exists both answers come from the same row and cannot
 * disagree; agent, task and page are the fallbacks, in that order, matching
 * the routes that already exist.
 */
async function resolveRunWorkspace(run: Run): Promise<number | null> {
  if (run.sessionId != null) {
    const session = await getChatSession(run.sessionId).catch(() => null)
    if (session) return session.workspaceId
  }
  const payload = await getPayloadClient()
  if (run.agentId != null) {
    const agent = await payload
      .findByID({ collection: 'agents', id: run.agentId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    const workspaceId = typeof agent?.workspace === 'number' ? agent.workspace : agent?.workspace?.id
    if (workspaceId) return workspaceId
  }
  if (run.taskId != null) {
    const task = await payload
      .findByID({ collection: 'tasks', id: run.taskId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    const workspaceId = typeof task?.workspace === 'number' ? task.workspace : task?.workspace?.id
    if (workspaceId) return workspaceId
  }
  if (run.pageId != null) {
    const page = await payload
      .findByID({ collection: 'pages', id: run.pageId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    const workspaceId = typeof page?.workspace === 'number' ? page.workspace : page?.workspace?.id
    if (workspaceId) return workspaceId
  }
  return null
}

/**
 * The block vocabulary an agent may emit.
 *
 * **This is deliberately only heading / paragraph / list / code**, which is
 * everything `AgentBlockSpec` in `lib/agent-page-writes.ts` covers today.
 *
 * R8.5 asks for `table`, `run_card`, `task`, `agent_session`, `quote`,
 * `divider` and `image` on top of these, and every one of them is a change to
 * `AgentBlockSpec` and its `doc.addBlock` switch — that is, to
 * `agent-page-writes.ts`, which this unit does not own and must not edit.
 * Declaring, say, a `table` here and mapping it to something this write path
 * cannot build would produce a tool that accepts the call and then throws (or
 * worse, silently degrades a table into a paragraph). An agent that is told
 * it has four block kinds and really has four is strictly better than one
 * told it has eleven.
 *
 * `diff` is a further case and stays out for a harder reason: no diff block
 * flavour exists anywhere in the codebase, so it needs a schema, a custom
 * element, a spec and registration before any tool can name it.
 */
const blockSchema = z.object({
  kind: z.enum(['heading', 'paragraph', 'list', 'code']),
  text: z.string().min(1).max(100_000),
  level: z.coerce.number().int().min(1).max(3).optional(),
  listType: z.enum(['bulleted', 'numbered', 'todo']).optional(),
  checked: z.boolean().optional(),
  language: z.string().optional(),
})

type BlockInput = z.infer<typeof blockSchema>

/** Reassembled into the discriminated shape the write path validates, rather
 * than passed through: MCP hands us a flat argument object, and
 * `AgentBlockSpec` is the contract `appendBlockToSubtree` actually checks. */
function toSpec(input: BlockInput): AgentBlockSpec {
  if (input.kind === 'heading') return { kind: 'heading', text: input.text, level: (input.level ?? 2) as 1 | 2 | 3 }
  if (input.kind === 'list')
    return {
      kind: 'list',
      text: input.text,
      type: input.listType ?? 'bulleted',
      ...(input.checked === undefined ? {} : { checked: input.checked }),
    }
  if (input.kind === 'code') return { kind: 'code', text: input.text, language: input.language ?? null }
  return { kind: 'paragraph', text: input.text }
}

/**
 * Builds a server bound to one authorised run.
 *
 * A fresh instance per request rather than a module-level singleton: the
 * server closes over the caller's identity, and sharing one would leak a
 * run's authorisation into another run's tool calls.
 */
function buildServer(run: Run, workspaceId: number, origin: string) {
  const server = new McpServer({ name: 'notionforge-artifacts', version: '1.0.0' })

  /** Absolute, because the caller is an agent that may be on another machine
   * and cannot resolve a site-relative path against anything. */
  const absolute = (path: string) => new URL(path, origin).toString()

  server.registerTool(
    'artifact_create',
    {
      description:
        'Create an artifact — a document you author for the human, opened beside the conversation. Use it for structure (tables, specs, plans, comparisons, reports, anything they will edit afterwards); keep prose in the reply. A short answer never needs one. Returns the artifact id and a URL that opens it.',
      inputSchema: {
        kind: z.enum(['page', 'html']).default('page'),
        title: z.string().min(1).max(300),
        project: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Project to file this into. Omit it: by default the artifact goes wherever this conversation's session lives, and into the human's Artifacts inbox when the session has no project.",
          ),
        html: z
          .string()
          .max(ARTIFACT_HTML_MAX_BYTES)
          .optional()
          .describe("The document body. Only for kind 'html'; a page artifact is filled with artifact_append."),
      },
    },
    async ({ kind, title, project, html }) => {
      try {
        const payload = await getPayloadClient()
        const { artifact, openPath } = await createArtifact(payload, {
          workspaceId,
          kind,
          title,
          projectId: project ?? null,
          sessionId: run.sessionId ?? null,
          runId: run.id,
          agentId: run.agentId ?? null,
          taskId: run.taskId ?? null,
          htmlContent: kind === 'html' ? (html ?? '') : null,
        })
        return jsonResult({
          artifact: artifact.id,
          kind: artifact.kind,
          title: artifact.name,
          page: artifact.pageId,
          project: artifact.projectId,
          // Says where it landed and why, because the placement rule is
          // invisible from the agent's side and it will otherwise assume the
          // artifact is loose whenever it did not pass a project.
          placement: artifact.projectId == null ? 'loose (in the Artifacts inbox)' : `filed into project ${artifact.projectId}`,
          url: absolute(openPath),
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'artifact_append',
    {
      description:
        'Append blocks, in order, to the end of a page artifact. Send the whole section in one call rather than one call per paragraph. Appends only: this can never modify or delete anything already on the page.',
      inputSchema: {
        artifact: z.coerce.number().int().positive(),
        blocks: z.array(blockSchema).min(1).max(200),
      },
    },
    async ({ artifact: artifactId, blocks }) => {
      try {
        const written = blocksWrittenByRun.get(run.id) ?? 0
        if (written + blocks.length > MAX_BLOCKS_PER_RUN) {
          return errorResult(
            new Error(
              `This run has written ${written} blocks and the ceiling is ${MAX_BLOCKS_PER_RUN}. Summarise instead of continuing to append.`,
            ),
          )
        }

        const payload = await getPayloadClient()
        const artifact = await getArtifact(payload, artifactId)
        if (!artifact) return errorResult(new Error(`Artifact ${artifactId} was not found.`))
        // The tenancy check. A run token authorises a run, not a workspace,
        // so without this an agent could name any artifact id in the
        // database and append to it.
        if (artifact.workspaceId !== workspaceId) {
          return errorResult(new Error(`Artifact ${artifactId} was not found.`))
        }

        const specs = blocks.map(toSpec)
        const { blockIds, pageId, subtreeBlockId } = await appendArtifactBlocks(payload, artifactId, specs)
        blocksWrittenByRun.set(run.id, written + blockIds.length)

        // One event per block, not one per call. R8.6 wants blocks to appear
        // in the panel as they are written, and these events are the stream
        // that carries that; collapsing them into a single "wrote 12 blocks"
        // event would make the panel jump instead of fill.
        for (let i = 0; i < blockIds.length; i += 1) {
          await appendRunEvent(run.id, {
            type: 'page_write',
            pageId,
            // From the append itself, not from the artifact record read
            // above: on an artifact's first append the subtree is created
            // during that call, so the record still says null here and the
            // old `?? blockIds[i]` fallback named the appended block as its
            // own parent in every event of the first batch.
            subtree: subtreeBlockId,
            blockId: blockIds[i],
            operation: 'append',
            kind: specs[i].kind,
            status: 'committed',
          })
        }

        return jsonResult({ artifact: artifactId, page: pageId, appended: blockIds.length, blockIds })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'artifact_read',
    {
      description:
        'Read an artifact back as block specs, so you can revise a document instead of starting over. Blocks whose kind you cannot write are reported as "unsupported" rather than hidden — do not assume they are absent.',
      inputSchema: { artifact: z.coerce.number().int().positive() },
    },
    async ({ artifact: artifactId }) => {
      try {
        const payload = await getPayloadClient()
        const existing = await getArtifact(payload, artifactId)
        if (!existing || existing.workspaceId !== workspaceId) {
          return errorResult(new Error(`Artifact ${artifactId} was not found.`))
        }
        const { artifact, blocks, html } = await readArtifactBlocks(payload, artifactId)
        return jsonResult({
          artifact: artifact.id,
          title: artifact.name,
          kind: artifact.kind,
          project: artifact.projectId,
          ...(artifact.kind === 'html' ? { html } : { blocks }),
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'artifact_list',
    {
      description:
        'List artifacts in this workspace, newest first. Omit every filter to see everything; pass project to narrow to one project, or session to see what one conversation produced.',
      inputSchema: {
        project: z.coerce.number().int().positive().optional(),
        session: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(25),
      },
    },
    async ({ project, session, limit }) => {
      try {
        const payload = await getPayloadClient()
        const artifacts = await listArtifacts(payload, {
          workspaceId,
          project: project ?? undefined,
          sessionId: session ?? undefined,
          limit,
        })
        return jsonResult(
          artifacts.map((artifact) => ({
            artifact: artifact.id,
            title: artifact.name,
            kind: artifact.kind,
            project: artifact.projectId,
            session: artifact.sessionId,
            createdAt: artifact.createdAt,
          })),
        )
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  // NOT registered: `artifact_update_block`. R8.5 lists it, and it cannot be
  // built without the second ownership mode described in the same section —
  // a run that owns the whole document and may legitimately call
  // `updateBlock`. `lib/agent-page-writes.ts` exposes no update path at all,
  // by design ("never calls updateBlock/deleteBlock"), and that file is not
  // this unit's to change. A tool registered here that reached around it
  // would delete the one guarantee the write path exists to provide, so this
  // server ships four verbs and says so rather than five and lies.

  return server
}

function refuse(message: string, status: number): Response {
  // JSON-RPC-shaped, because the caller is an MCP client: a bare text body
  // reaches it as a parse error rather than as a reason it can report.
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handle(request: Request): Promise<Response> {
  const header = request.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  const runId = Number(request.headers.get('x-run-id'))
  if (!token || !Number.isSafeInteger(runId)) {
    return refuse('Unauthorized: a run token and X-Run-Id are required.', 401)
  }

  const run = await getRun(runId).catch(() => null)
  if (!run) return refuse('Unauthorized: unknown run.', 401)
  // Compared against this run's own token, so naming a different run id does
  // not help an attacker holding some other run's token.
  if (!run.runToken || run.runToken !== token) return refuse('Unauthorized: invalid run token.', 401)
  // A settled run must not keep writing. Its transcript is closed and its
  // review may already have been read.
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return refuse('This run has already finished.', 409)
  }

  // Resolved once per request rather than per tool call: it is up to four
  // lookups and every tool here needs it.
  const workspaceId = await resolveRunWorkspace(run)
  if (workspaceId == null) {
    return refuse('This run is not attached to a workspace, so it has nowhere to author an artifact.', 409)
  }

  const server = buildServer(run, workspaceId, new URL(request.url).origin)
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id, so nothing is retained between requests and
    // nothing has to be cleaned up if a caller disappears.
    sessionIdGenerator: undefined,
    // See this file's header: SSE plus the per-request cleanup below is an
    // empty 200. These tools stream nothing anyway.
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } finally {
    // Both are per-request; leaving them open would leak a server and a
    // transport for every tool call this workspace ever makes. Safe here only
    // because the response above is already complete.
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}

export const POST = handle
export const GET = handle
export const DELETE = handle
