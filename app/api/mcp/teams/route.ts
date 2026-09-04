// R6.2 — the team MCP server, over HTTP.
//
// This is the divergence the roadmap calls the most important one in R6. The
// reference implementation injects a team MCP server into each member over
// **stdio**, which works only because their processes are co-located: team
// membership is then gated on "does this runtime speak stdio MCP", and a
// member on another machine is impossible. Serving the same tool surface over
// HTTP (built in R4) moves the gate to "does this runtime speak HTTP MCP", and
// makes every tool call a request this app authenticates, authorises and can
// log — none of which a pipe between two local processes offers.
//
// Structure and both load-bearing details are copied from `app/api/mcp/route.ts`
// on purpose; see the comments at `buildServer` and on `enableJsonResponse`.
// The tool bodies live in `lib/teams/tools.ts` so the permission rules can be
// read on their own.
//
// R6.4 adds the three tools that make a member a PARTICIPANT in the channel
// rather than a bot posting into it: a reply that lands under the message that
// prompted it (`threadRootId` on `team_send_message`), the thread read that
// makes such a reply answerable (`team_read_thread`), and an acknowledgement
// that costs the room nothing to read (`team_react`). The tool DESCRIPTIONS
// below carry more weight than usual for these: an agent will only thread a
// reply if the description tells it when to, so each one says when to reach
// for the tool, not merely what it does.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { getRun } from '@/lib/broker/runs'
import {
  resolveTeamCaller,
  teamClaimTask,
  teamConnectApp,
  teamCreateTask,
  teamListTasks,
  teamReact,
  teamReadInbox,
  teamReadThread,
  teamReportDone,
  teamSendMessage,
  teamUpdateTask,
  TeamPermissionError,
  type TeamCaller,
} from '@/lib/teams/tools'

export const dynamic = 'force-dynamic'
// Postgres is Node-only; none of this runs on the edge.
export const runtime = 'nodejs'

const TASK_STATUS = z.enum(['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled'])
const MESSAGE_KIND = z.enum(['instruction', 'report', 'question', 'answer', 'status'])

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * Renders a failure as a tool result rather than letting it escape.
 *
 * A refusal the *agent* can read is the point: `TeamPermissionError` carries a
 * sentence saying which slot it is and what to do instead ("ask the leader"),
 * and that sentence is worth more to a model than any status code. Genuine
 * faults come back the same way for the same reason — a tool call that throws
 * out of the handler reaches the client as a transport error with no context.
 */
function errorResult(error: unknown) {
  const message =
    error instanceof TeamPermissionError
      ? `Refused: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error)
  return { isError: true, content: [{ type: 'text' as const, text: message }] }
}

/**
 * Builds a server bound to one authorised slot.
 *
 * Fresh per request, never a module-level singleton: `caller` is baked into
 * every handler below, and a shared server would hand one team's slot the
 * authorisation of whoever connected last. Every tool derives its team and its
 * role from this closure — nothing a caller sends can name a slot or a team.
 */
function buildServer(caller: TeamCaller) {
  const server = new McpServer({ name: 'notionforge-teams', version: '1.0.0' })

  server.registerTool(
    'team_send_message',
    {
      description:
        'Post in the team channel, or to one teammate if `to` is given. Reply UNDER a message by passing its id ' +
        'as `threadRootId` — do that whenever you are answering something rather than raising something new, ' +
        'or your answer lands in the feed detached from the question. Mention a teammate by writing @ and their ' +
        'exact display name in the body; that is recorded as a real mention and shows in their badge. ' +
        "Kind 'instruction' may only be sent by the team leader. Returns the posted message, including the id you " +
        'need for team_react and for further replies.',
      inputSchema: {
        to: z.coerce.number().int().positive().optional().describe('Recipient slot id. Omit to post to the channel.'),
        kind: MESSAGE_KIND.default('status'),
        body: z.string().min(1).max(100_000),
        task: z.coerce.number().int().positive().optional().describe('Task id this message is about.'),
        threadRootId: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Id of the message you are replying to. Replying to a reply attaches to the same thread rather than ' +
              'nesting, so you can pass either the root or any message in the thread.',
          ),
      },
    },
    async ({ to, kind, body, task, threadRootId }) => {
      try {
        return textResult(
          await teamSendMessage(caller, {
            to: to ?? null,
            kind,
            body,
            task: task ?? null,
            threadRootId: threadRootId ?? null,
          }),
        )
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'team_read_thread',
    {
      description:
        'Read one thread: the message that started it plus its replies, oldest first. Use this after someone ' +
        'replies to you, or before answering a follow-up, so you answer the actual question rather than the ' +
        "summary of it in the feed. Passing a reply id works — it resolves to that reply's thread. A very long " +
        'thread comes back as the root plus the most recent replies, with `truncated: true` and how many were ' +
        'omitted; `total` is always the real length.',
      inputSchema: {
        rootId: z.coerce.number().int().positive().describe('The id of the thread root, or of any reply in it.'),
      },
    },
    async ({ rootId }) => {
      try {
        return textResult(await teamReadThread(caller, { rootId }))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'team_react',
    {
      description:
        'React to a message with a single emoji, and call it again with the same emoji to take the reaction back. ' +
        'Prefer this over posting "ok" or "seen" — it acknowledges without adding a message everyone else then ' +
        'has to read. Returns `added: true` if the reaction was placed, `added: false` if it was removed.',
      inputSchema: {
        messageId: z.coerce.number().int().positive(),
        // Short and whitespace-free: this is a reaction, not a second body.
        // Bounded here rather than in the tool so an over-long value is
        // refused by the schema before it reaches a write.
        emoji: z.string().trim().min(1).max(16).regex(/^\S+$/, 'A reaction is a single emoji, with no spaces.'),
      },
    },
    async ({ messageId, emoji }) => {
      try {
        return textResult(await teamReact(caller, { messageId, emoji }))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'team_read_inbox',
    {
      description:
        'Read messages addressed to you plus team broadcasts. `since` is a MESSAGE ID, not a timestamp — ' +
        'pass back the `cursor` from the previous call to get only what is new. Omit it the first time.',
      inputSchema: {
        since: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      },
    },
    async ({ since, limit }) => {
      try {
        return textResult(await teamReadInbox(caller, { since, limit }))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'team_list_tasks',
    {
      description:
        "The team's board. Optionally filter by status. A task with `owner: null` and status 'open' is one you " +
        'can try to claim.',
      inputSchema: { status: TASK_STATUS.optional() },
    },
    async ({ status }) => {
      try {
        return textResult(await teamListTasks(caller, { status }))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'team_create_task',
    {
      description:
        'Create a task on the board, optionally assigning it and declaring what it is blocked by. ' +
        'Leader only — members should ask the leader instead.',
      inputSchema: {
        subject: z.string().min(1).max(2_000),
        description: z.string().max(100_000).optional(),
        assignTo: z.coerce.number().int().positive().optional().describe('Slot id to assign this task to.'),
        blockedBy: z
          .array(z.coerce.number().int().positive())
          .optional()
          .describe('Task ids that must finish first. The task starts blocked and opens automatically.'),
      },
    },
    async ({ subject, description, assignTo, blockedBy }) => {
      try {
        return textResult(
          await teamCreateTask(caller, {
            subject,
            description: description ?? null,
            assignTo: assignTo ?? null,
            blockedBy: blockedBy ?? [],
          }),
        )
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'team_claim_task',
    {
      description:
        'Take ownership of an unclaimed task. If another member claimed it first this returns claimed:false with ' +
        'the reason — that is a normal outcome, not a fault. Do not retry it; pick a different task.',
      inputSchema: { id: z.coerce.number().int().positive() },
    },
    async ({ id }) => {
      try {
        return textResult(await teamClaimTask(caller, { id }))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'team_update_task',
    {
      description:
        "Move a task you own to 'claimed', 'in_progress' or 'blocked'. Use team_report_done to finish it; " +
        "'done' and 'cancelled' are the leader's to set.",
      inputSchema: { id: z.coerce.number().int().positive(), status: TASK_STATUS },
    },
    async ({ id, status }) => {
      try {
        return textResult(await teamUpdateTask(caller, { id, status }))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'team_report_done',
    {
      description:
        'Finish a task you own: settles it, records what it produced, and files your report to the team in one ' +
        'transaction. Returns the tasks that are claimable now that this one is finished.',
      inputSchema: {
        task: z.coerce.number().int().positive(),
        summary: z.string().min(1).max(100_000).describe('What the task produced. This becomes the team report.'),
      },
    },
    async ({ task, summary }) => {
      try {
        return textResult(await teamReportDone(caller, { task, summary }))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  // Registered on THIS server rather than on `/api/mcp` because this is the
  // one a dispatched member actually reaches: the only MCP plugin rows in the
  // database point here, and `lib/plugins/resolve.ts` substitutes the
  // `{{TEAM_SLOT_ID}}` header this endpoint needs. A tool on a server nothing
  // is configured to call is a tool that does not exist.
  server.registerTool(
    'connect_app',
    {
      description:
        'Ask the person you are working for to authorise a third-party app (Gmail, Slack, GitHub, …) so you can ' +
        'use it. THIS CALL BLOCKS while they sign in, and can take several minutes — that is expected, not a ' +
        'hang, so do not abandon it and do not call it twice for the same app. It returns `connected: true` once ' +
        'the authorisation is live, and a reason when it is not. Call it only when a tool you need has actually ' +
        'refused for want of a connection; if it returns `connected: false`, say what you could not do and carry ' +
        'on rather than asking again.',
      inputSchema: {
        toolkit: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe("The app's slug, e.g. 'gmail', 'slack', 'github'. Not a display name."),
      },
    },
    async ({ toolkit }) => {
      try {
        return textResult(await teamConnectApp(caller, { toolkit }))
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
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Authentication, in two halves.
 *
 * The first half is exactly `/api/mcp`'s: a bearer run token compared against
 * that run's own `run_token`, plus `X-Run-Id`. Deliberately not a second
 * credential scheme — one authorisation rule for agent writes rather than two
 * that drift apart, and the plugin layer already substitutes `{{RUN_TOKEN}}` /
 * `{{RUN_ID}}` at resolve time so nothing new has to be minted or stored.
 *
 * The second half is new and specific to teams: `X-Team-Slot-Id` says which
 * slot the caller is acting as, and `resolveTeamCaller` proves the run is
 * entitled to it. Without that a valid run token would be a key to every team
 * in the installation, since slot ids are small guessable integers.
 *
 * NOT YET WIRED: `lib/plugins/resolve.ts` substitutes `{{RUN_TOKEN}}` and
 * `{{RUN_ID}}` into plugin headers but has no `{{TEAM_SLOT_ID}}`, so a plugin
 * row cannot yet fill this third header per run — a member's plugin would have
 * to hard-code its slot id, which is wrong for the same reason hard-coding a
 * token would be. Adding that substitution is a one-line change in that file,
 * which this unit does not own; until it lands, this endpoint is reachable by
 * a client that sets the header itself but not by a dispatched member.
 */
async function handle(request: Request): Promise<Response> {
  const header = request.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  const runId = Number(request.headers.get('x-run-id'))
  const slotId = Number(request.headers.get('x-team-slot-id'))
  if (!token || !Number.isSafeInteger(runId)) {
    return refuse('Unauthorized: a run token and X-Run-Id are required.', 401)
  }
  if (!Number.isSafeInteger(slotId) || slotId <= 0) {
    return refuse('Unauthorized: X-Team-Slot-Id must be the numeric team slot this run is acting as.', 401)
  }

  const run = await getRun(runId).catch(() => null)
  if (!run) return refuse('Unauthorized: unknown run.', 401)
  // Compared against this run's own token, so naming a different run id does
  // not help an attacker holding some other run's token.
  if (!run.runToken || run.runToken !== token) return refuse('Unauthorized: invalid run token.', 401)
  // A settled run must not keep writing. Its transcript is closed, and a
  // finished member claiming board work would be a task nobody is doing.
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return refuse('This run has already finished.', 409)
  }

  const resolved = await resolveTeamCaller({
    slotId,
    runId,
    runAgentId: run.agentId,
    runSessionId: run.sessionId,
  })
  if (!resolved.ok) return refuse(resolved.message, resolved.status)

  const server = buildServer(resolved.caller)
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id, so nothing is retained between requests and
    // nothing has to be cleaned up if a caller disappears.
    sessionIdGenerator: undefined,
    // One request, one complete JSON response, rather than an SSE stream.
    // Not a style preference — it is what makes the cleanup below correct.
    // With SSE the transport returns a Response whose body is still being
    // written, so closing the server when `handleRequest` returns tears the
    // stream down before a byte reaches the client: a 200 with an empty body,
    // which is exactly what `/api/mcp` produced before this flag was set.
    // These tools are request/response and stream nothing.
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } finally {
    // Both are per-request; leaving them open would leak a server and a
    // transport for every tool call any team ever makes. Safe here only
    // because the response above is already complete.
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}

export const POST = handle
export const GET = handle
export const DELETE = handle
