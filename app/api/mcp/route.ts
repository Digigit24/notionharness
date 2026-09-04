// R4.6 — our own MCP server, over HTTP, as the first real consumer of the
// plugin layer.
//
// The registry (R4.1) and the HTTP transport (R4.2) are only worth anything if
// something actually uses them, so this is built against a real endpoint
// rather than a hypothetical one. It is the tool surface
// `scripts/notionforge-mcp.ts` already exposes over stdio, moved to where an
// agent on another machine can reach it — which is the whole point of R4.2 and
// the thing a stdio-only design makes impossible.
//
// **Auth is the same one runs already have.** A dispatched run carries a
// `run_token`, and `/api/daemon/page-writes` already authorises against it by
// comparing the presented token to that run's own. This does exactly that,
// including refusing a settled run, so there is one authorisation rule for
// agent writes rather than two that can drift. The plugin layer gets the
// per-run values in via `{{RUN_TOKEN}}` / `{{RUN_ID}}` placeholders
// substituted at resolve time (see `lib/plugins/resolve.ts`) — a plugin row is
// static configuration and must never hold a live credential.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { appendBlockToSubtree, createRunSubtree, type AgentBlockSpec } from '@/lib/agent-page-writes'
import { appendRunEvent } from '@/lib/broker/messages'
import { getRun, getRunPageContext, setRunPageContext } from '@/lib/broker/runs'
import { loadDoc, docToMarkdown } from '@/lib/blocksuite-doc'
import { getPayloadClient } from '@/lib/payload'
import { ensureTaskPage } from '@/lib/task-pages'

export const dynamic = 'force-dynamic'
// Postgres and BlockSuite are both Node-only; neither runs on the edge.
export const runtime = 'nodejs'

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
  }
}

/**
 * Builds a server bound to one authorised run.
 *
 * A fresh instance per request rather than a module-level singleton: the
 * server closes over the caller's identity, and sharing one would leak a run's
 * authorisation into another run's tool calls. Constructing it is cheap;
 * getting this wrong is not.
 */
function buildServer(runId: number, taskId: number | null) {
  const server = new McpServer({ name: 'notionforge', version: '1.0.0' })

  server.registerTool(
    'get_page',
    {
      description: 'Read a NotionForge page as Markdown. Supply its numeric page ID.',
      inputSchema: { pageId: z.coerce.number().int().positive() },
    },
    async ({ pageId }) => {
      try {
        const payload = await getPayloadClient()
        const page = await payload
          .findByID({ collection: 'pages', id: pageId, overrideAccess: true, disableErrors: true })
          .catch(() => null)
        if (!page) return errorResult(new Error(`Page ${pageId} was not found.`))
        const title = page.title || 'Untitled'
        const { doc } = loadDoc(pageId, title, page.docState)
        return textResult(await docToMarkdown(doc, title))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'append_block',
    {
      description:
        "Append one block to this run's own section of its task page. Can only add; never modifies or deletes anything already there. The section is created on first use.",
      inputSchema: {
        kind: z.enum(['heading', 'paragraph', 'list', 'code']),
        text: z.string().min(1).max(100_000),
        level: z.coerce.number().int().min(1).max(3).optional(),
        listType: z.enum(['bulleted', 'numbered', 'todo']).optional(),
        checked: z.boolean().optional(),
        language: z.string().optional(),
      },
    },
    async (input) => {
      try {
        if (taskId == null) {
          return errorResult(new Error('This run has no task page to write to.'))
        }
        // Reassembled into the shape `appendBlockToSubtree` validates, rather
        // than passed through: MCP gives us a flat argument object, and that
        // module's discriminated spec is the contract the write path checks.
        const spec = ((): AgentBlockSpec => {
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
        })()

        const payload = await getPayloadClient()
        // Same lazy-subtree behaviour as the daemon bridge: a run that never
        // writes never creates an empty section on someone's page.
        let context = await getRunPageContext(runId)
        if (!context) {
          const pageId = await ensureTaskPage(payload, taskId)
          const subtreeBlockId = await createRunSubtree(payload, pageId, `Agent run #${runId}`)
          await setRunPageContext(runId, pageId, subtreeBlockId)
          context = { pageId, subtreeBlockId }
        }
        const blockId = await appendBlockToSubtree(payload, context.pageId, context.subtreeBlockId, spec)
        await appendRunEvent(runId, {
          type: 'page_write',
          pageId: context.pageId,
          subtree: context.subtreeBlockId,
          blockId,
          operation: 'append',
          kind: spec.kind,
          status: 'committed',
        })
        return textResult(`Appended a ${spec.kind} block to page ${context.pageId}.`)
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  return server
}

function refuse(message: string, status: number): Response {
  // JSON-RPC-shaped, because the caller is an MCP client: a bare text body
  // reaches it as a parse error rather than as a reason it can report.
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
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

  const server = buildServer(runId, run.taskId)
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id, so nothing is retained between requests and
    // nothing has to be cleaned up if a caller disappears.
    sessionIdGenerator: undefined,
    // One request, one complete JSON response, rather than an SSE stream.
    // This is not a style preference — it is what makes the cleanup below
    // correct. With SSE the transport returns a Response whose body is still
    // being written, so closing the server when `handleRequest` returns tore
    // the stream down before a single byte reached the client: a 200 with an
    // empty body, which the first live test produced exactly. These tools are
    // request/response anyway and stream nothing.
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
