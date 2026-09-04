// B-3 "Surface" (ROADMAP B1.3) — real Postgres full-text search backing the
// ⌘K command bar's navigate mode. Recreates what B-0 deleted (the old
// 492-byte lib/search.ts, retired as "superseded" once the command bar's
// `like`-based placeholder shipped — see AGENTS.md's B-0 log entry) for
// real this time, over pages/tasks/projects/agents/comments/run
// transcripts. The one caller is `searchCommandBar` in
// `app/(app)/workspace/[workspaceSlug]/command-bar/actions.ts`; see that
// file's own SEAM comment and `components/command-bar/types.ts` for how
// this plugs into the palette without touching its rendering/routing.
//
// FULL-TEXT APPROACH: live `to_tsvector(...)` computed at query time — no
// stored `tsvector` column, no `GIN` index, no migration. The alternative
// (a generated `tsvector` column + `GIN` index via a handwritten Payload
// migration — the exact pattern already used for
// `migrations/20260902_100000_pages_project.ts` and
// `lib/broker/migrations/0005_run_suggestion_status.sql`, both "written,
// not applied" per AGENTS.md, and a genuinely safe, precedented way to do
// it in this repo) was considered and set aside for *this* pass because:
//   - Two other B-3 batches (docked page-agent panel, product blocks/
//     slash-menu commands) are editing this same schema concurrently. A
//     migration is a shared, coordination-sensitive resource; a
//     live-computed query is a pure addition that can never conflict with
//     either of them.
//   - Unlike `pages.project_id`, this feature has no acceptable "ship the
//     migration file now, a human applies it later" story — the command
//     bar's search box needs to actually return results the moment this
//     merges, not after a follow-up step someone might forget.
//   - This repo's likely scale (a handful of workspaces, each with at most
//     a few thousand pages/tasks/comments/run messages) is nowhere near
//     where computing `to_tsvector` per-query becomes a real bottleneck —
//     Postgres builds it from already-cached heap pages, not a disk scan.
// Follow-up, if search volume or table size ever makes this measurably
// slow: add `tsv tsvector GENERATED ALWAYS AS (...) STORED` + a `GIN`
// index per table via the same handwritten-migration pattern already
// established here, then swap the `to_tsvector(...)` call sites below for
// `tsv @@ query` / `ts_rank(tsv, query)`. Every query here is written so
// that swap only ever touches this file.
//
// CONNECTION: reuses `getBrokerPool()` (`lib/broker/db.ts`) rather than
// opening a second `pg.Pool` — this project's Postgres is a small shared
// instance with a real connection cap (see that file's own comment), and
// `lib/broker/runs.ts` already establishes the precedent of joining
// Payload-owned tables (`tasks`) straight through that same pool
// (`listActiveRunsForWorkspace`'s `runs r INNER JOIN tasks t`) rather than
// only ever using it for the raw-pg-owned broker tables.

import { getBrokerPool } from '@/lib/broker'
import { HERMES_API_KEY, HERMES_BASE_URL } from '@/lib/runtimes/hermes/api-proxy'

export interface RankedId {
  id: number
  rank: number
}

export interface CommentSearchResult {
  id: number
  body: string
  taskId: number
  taskTitle: string
}

export interface RunTranscriptSearchResult {
  id: number
  status: string
  taskId: number
  taskTitle: string
}

export interface SkillSearchResult {
  name: string
  description: string
}

/**
 * Type-ahead needs prefix matching ("wor" -> "workspace", "worktree"), which
 * `plainto_tsquery`/`websearch_to_tsquery` do NOT do (they match whole,
 * stemmed words only, which is wrong for a query box the user is still
 * typing into). Build a `to_tsquery`-compatible string instead: each
 * whitespace-separated word becomes a `word:*` prefix term, ANDed together.
 *
 * Every token is stripped to `[a-zA-Z0-9]` before it goes anywhere near
 * `to_tsquery` — that's what makes it safe to interpolate the *string*
 * `to_tsquery` itself parses as a mini expression language (it has its own
 * operators: `&`, `|`, `!`, `:*`, parens). A bound query parameter alone
 * only protects against SQL injection; it does nothing to stop a value
 * like `foo | (bar` from being a syntactically-broken (or maliciously
 * shaped) tsquery once Postgres parses *that* string. Stripping every
 * token to alphanumerics first removes that surface entirely — no token
 * can ever contain tsquery's own syntax.
 */
function buildPrefixTsQuery(query: string): string | null {
  const words = query
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
    .slice(0, 8) // a runaway paste shouldn't build an unbounded AND chain
  if (words.length === 0) return null
  return words.map((w) => `${w}:*`).join(' & ')
}

/** Pages navigate-mode category — title + `plainTextContent` (kept fresh on
 * every sync, per `collections/Pages.ts`'s own field description).
 * Returns ranked ids only; the caller (`searchCommandBar`) hydrates full
 * `Page` docs via Payload's Local API so every other reader of that result
 * shape keeps working unchanged. */
export async function searchPageIds(workspaceId: number, query: string, limit: number): Promise<RankedId[]> {
  const tsQuery = buildPrefixTsQuery(query)
  if (!tsQuery) return []
  const pool = getBrokerPool()
  const res = await pool.query<{ id: number; rank: number }>(
    `SELECT id,
            ts_rank(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(plain_text_content, '')), to_tsquery('english', $2)) AS rank
     FROM pages
     WHERE workspace_id = $1
       AND is_archived = false
       AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(plain_text_content, '')) @@ to_tsquery('english', $2)
     ORDER BY rank DESC
     LIMIT $3`,
    [workspaceId, tsQuery, limit],
  )
  return res.rows.map((r) => ({ id: Number(r.id), rank: Number(r.rank) }))
}

/** Tasks navigate-mode category. `collections/Tasks.ts` has no description
 * field (confirmed) — title is the only real text to index. */
export async function searchTaskIds(workspaceId: number, query: string, limit: number): Promise<RankedId[]> {
  const tsQuery = buildPrefixTsQuery(query)
  if (!tsQuery) return []
  const pool = getBrokerPool()
  const res = await pool.query<{ id: number; rank: number }>(
    `SELECT id, ts_rank(to_tsvector('english', coalesce(title, '')), to_tsquery('english', $2)) AS rank
     FROM tasks
     WHERE workspace_id = $1
       AND to_tsvector('english', coalesce(title, '')) @@ to_tsquery('english', $2)
     ORDER BY rank DESC
     LIMIT $3`,
    [workspaceId, tsQuery, limit],
  )
  return res.rows.map((r) => ({ id: Number(r.id), rank: Number(r.rank) }))
}

/** Projects — name + description. Not a stale B-0 omission: B-0's
 * `NAVIGATE_PROVIDERS` comment excluded projects because no detail route
 * existed yet, but `roadmap/b1-project-detail` (same day) shipped
 * `projects/[projectId]/page.tsx` — confirmed present in this tree via
 * `lib/entity-links.server.ts`'s `hrefForEntity('project', ...)`. That
 * blocking reason is gone, so this batch also re-adds `projects` to
 * `NAVIGATE_PROVIDERS` in `components/command-bar/types.ts`. */
export async function searchProjectIds(workspaceId: number, query: string, limit: number): Promise<RankedId[]> {
  const tsQuery = buildPrefixTsQuery(query)
  if (!tsQuery) return []
  const pool = getBrokerPool()
  const res = await pool.query<{ id: number; rank: number }>(
    `SELECT id,
            ts_rank(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')), to_tsquery('english', $2)) AS rank
     FROM projects
     WHERE workspace_id = $1
       AND to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')) @@ to_tsquery('english', $2)
     ORDER BY rank DESC
     LIMIT $3`,
    [workspaceId, tsQuery, limit],
  )
  return res.rows.map((r) => ({ id: Number(r.id), rank: Number(r.rank) }))
}

/** Agents — name + instructions (the closest thing an agent has to a
 * description; `collections/Agents.ts` confirmed). */
export async function searchAgentIds(workspaceId: number, query: string, limit: number): Promise<RankedId[]> {
  const tsQuery = buildPrefixTsQuery(query)
  if (!tsQuery) return []
  const pool = getBrokerPool()
  const res = await pool.query<{ id: number; rank: number }>(
    `SELECT id,
            ts_rank(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(instructions, '')), to_tsquery('english', $2)) AS rank
     FROM agents
     WHERE workspace_id = $1
       AND to_tsvector('english', coalesce(name, '') || ' ' || coalesce(instructions, '')) @@ to_tsquery('english', $2)
     ORDER BY rank DESC
     LIMIT $3`,
    [workspaceId, tsQuery, limit],
  )
  return res.rows.map((r) => ({ id: Number(r.id), rank: Number(r.rank) }))
}

/** Comments — `collections/Comments.ts` has no `workspace` field of its
 * own (it's task-only, per that collection's comment), so scoping joins
 * through the owning task, same "join through the Payload-owned table"
 * pattern `lib/broker/runs.ts` already established for runs. Fully
 * hydrated here (not a `RankedId` + Payload-hydrate round trip like
 * pages/tasks/projects/agents) because a comment's own render — body
 * snippet + parent task title — needs no other Payload fields. */
export async function searchComments(workspaceId: number, query: string, limit: number): Promise<CommentSearchResult[]> {
  const tsQuery = buildPrefixTsQuery(query)
  if (!tsQuery) return []
  const pool = getBrokerPool()
  const res = await pool.query<{ id: number; body: string; task_id: number; task_title: string }>(
    `SELECT c.id, c.body, c.task_id, t.title AS task_title
     FROM comments c
     INNER JOIN tasks t ON t.id = c.task_id
     WHERE t.workspace_id = $1
       AND to_tsvector('english', coalesce(c.body, '')) @@ to_tsquery('english', $2)
     ORDER BY ts_rank(to_tsvector('english', coalesce(c.body, '')), to_tsquery('english', $2)) DESC
     LIMIT $3`,
    [workspaceId, tsQuery, limit],
  )
  return res.rows.map((r) => ({ id: Number(r.id), body: r.body, taskId: Number(r.task_id), taskTitle: r.task_title }))
}

/**
 * Run transcripts — the plan's own headline example: "where did we decide
 * to use worktrees" should find the run that decided it. `run_messages`
 * stores one `RunEvent` per row as `jsonb` (`lib/broker/types.ts` /
 * `lib/run-events.ts`) — only `'message'` and `'thought'` variants carry a
 * free-text `text` field; `tool_call`/`tool_result`/`file_change`/etc. are
 * structured payloads, not prose, and are deliberately excluded rather
 * than full-texting a tool's raw JSON input/output as if it were English.
 *
 * One row per matching run, not per matching message: `DISTINCT ON
 * (rm.run_id)` picks each run's single best-ranked message, then the outer
 * query re-sorts by rank across runs (`DISTINCT ON`'s output order follows
 * its own `ORDER BY`, which has to start with the `DISTINCT ON` expression
 * — the outer `SELECT` is what actually ranks runs against each other).
 *
 * Scoped to this workspace via `runs -> tasks`, same join `lib/broker/
 * runs.ts`'s `listActiveRunsForWorkspace` already uses — which carries the
 * same honest limitation that function already has: a page-scoped run
 * (`taskId === null`, per `lib/broker/types.ts`'s `Run` interface) has no
 * task to join through and so is invisible to workspace-scoped search.
 * Broadening this to page-scoped runs would mean resolving a page's
 * workspace too (pages carry `workspace` directly, unlike runs) — a real
 * extension, not built here to keep this pass's join shape identical to
 * the one already proven correct elsewhere in this codebase.
 */
export async function searchRunTranscripts(
  workspaceId: number,
  query: string,
  limit: number,
): Promise<RunTranscriptSearchResult[]> {
  const tsQuery = buildPrefixTsQuery(query)
  if (!tsQuery) return []
  const pool = getBrokerPool()
  const res = await pool.query<{ id: number; status: string; task_id: number; task_title: string }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (rm.run_id)
              rm.run_id AS id, r.status, r.task_id, t.title AS task_title,
              ts_rank(to_tsvector('english', coalesce(rm.event ->> 'text', '')), to_tsquery('english', $2)) AS rank
       FROM run_messages rm
       INNER JOIN runs r ON r.id = rm.run_id
       INNER JOIN tasks t ON t.id = r.task_id
       WHERE t.workspace_id = $1
         AND rm.event ->> 'type' IN ('message', 'thought')
         AND to_tsvector('english', coalesce(rm.event ->> 'text', '')) @@ to_tsquery('english', $2)
       ORDER BY rm.run_id, rank DESC
     ) matched
     ORDER BY rank DESC
     LIMIT $3`,
    [workspaceId, tsQuery, limit],
  )
  return res.rows.map((r) => ({ id: Number(r.id), status: r.status, taskId: Number(r.task_id), taskTitle: r.task_title }))
}

/**
 * Skills — deliberately NOT part of the hot-path `Promise.all` the other
 * six categories run through on every keystroke. Skills live in Hermes's
 * own filesystem/API (`app/api/hermes/skills/route.ts` proxies
 * `GET {HERMES_BASE_URL}/api/skills`), not Postgres — there is no local
 * table to `to_tsvector` over, so "searching" skills means an actual HTTP
 * round trip to a separate service on every keystroke, for every workspace
 * a user has open. That's a materially different cost profile than the
 * other categories (single local Postgres query, sub-millisecond at this
 * scale) and doesn't belong in a debounced-but-still-per-keystroke
 * type-ahead path.
 *
 * Instead: called only when the user explicitly filters the palette to
 * "Skills" (`components/command-bar/command-bar.tsx`'s filter chips —
 * `searchCommandBar`'s `types` param). One request per debounced keystroke
 * *while that filter is active* is an accepted cost the other six
 * categories don't pay, in exchange for not silently dropping skills from
 * the plan's explicit entity list. Hermes's skills API has no server-side
 * search/query param (confirmed against `route.ts`, which only forwards
 * `category`) — filtered client-side (here) against name/description
 * instead, same substring approach `components/agents/agent-capabilities.
 * tsx`'s own skill list already uses.
 */
export async function searchSkills(query: string, limit: number): Promise<SkillSearchResult[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  try {
    const res = await fetch(`${HERMES_BASE_URL}/api/skills`, {
      headers: { Authorization: `Bearer ${HERMES_API_KEY}` },
      cache: 'no-store',
    })
    if (!res.ok) return []
    const payload: unknown = await res.json()
    const rows: unknown[] = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { skills?: unknown })?.skills)
        ? (payload as { skills: unknown[] }).skills
        : Array.isArray((payload as { items?: unknown })?.items)
          ? (payload as { items: unknown[] }).items
          : []

    const matched: SkillSearchResult[] = []
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const r = row as Record<string, unknown>
      const name = typeof r.name === 'string' ? r.name : typeof r.id === 'string' ? r.id : typeof r.slug === 'string' ? r.slug : ''
      if (!name) continue
      const description = typeof r.description === 'string' ? r.description : typeof r.summary === 'string' ? r.summary : ''
      if (name.toLowerCase().includes(q) || description.toLowerCase().includes(q)) {
        matched.push({ name, description })
        if (matched.length >= limit) break
      }
    }
    return matched
  } catch (err) {
    console.error('[search] Hermes skills search failed.', err)
    return []
  }
}
