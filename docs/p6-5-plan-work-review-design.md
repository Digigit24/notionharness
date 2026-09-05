# ROADMAP P6.5 — Plan / Work / Review modes: design

Status: design investigation, no code changes in this pass. Written by the
BlockSuite Specialist per task 01a060b4.

## What the roadmap actually asks for

> Not view tabs — product modes with different affordances. Plan is the doc
> editor with an agent that argues with you. Work is the inbox plus the
> board. Review is diffs, approvals and cost.

Already decided this session (not re-litigated here): mode switching is
always human-initiated, never proactive/automatic.

## What already exists (confirmed by reading the code, not assumed)

| Mode | Constituent pages | Route(s) |
|---|---|---|
| Plan | Doc editor (`BlockSuiteEditor`) + block-anchored agent threads (P6.2) | `/workspace/[slug]/p/[pageId]` |
| Work | Inbox (P5.5) + task board (P2.x) | `/workspace/[slug]/inbox`, `/workspace/[slug]/tasks` |
| Review | Per-run diff/approve surface (P6.4) | `/workspace/[slug]/runs/[runId]/review` |

All three already sit under one shared shell: `WorkspaceLayout`
(`app/(app)/workspace/[workspaceSlug]/layout.tsx`) renders `<Sidebar>` plus
`{children}` for every one of the routes above. The sidebar
(`components/sidebar/sidebar.tsx`) already has flat top-level links to
Tasks/Agents/Inbox, workspace switching, and its own `localStorage`-persisted
UI state (collapsed/expanded), all `pathname`-driven — there is no server-side
"current mode" concept anywhere today, and no precedent for one either.

Cross-navigation between entities already exists via `lib/entity-links.ts`'s
`hrefForEntity(payload, entityType, entityId)`, used by both the notification
bell and the Inbox: `task` → `/workspace/{slug}/tasks?task={id}` (opens the
task drawer over the board), `page` → `/workspace/{slug}/p/{id}`. `run` isn't
in this resolver yet — the review route exists but isn't part of the shared
link-resolution mechanism (see "new UI" below). Separately, `task-drawer.tsx`
already links a task to its most recent run's review directly
(`/workspace/{slug}/runs/{run.id}/review`) — so the underlying data
relationships needed for cross-mode linking mostly already exist; they're
just not unified into one resolver yet.

The Tasks↔Pages link built in P6.1 (`Tasks.page`, lazily populated by
`ensureTaskPage`) is the connective tissue between Work and Plan — a task's
linked page IS its Plan-mode home. **Known current limitation**: `Tasks.page`
is only populated the first time an agent run writes into a task's document
(P6.1's lazy-create decision), so most tasks today have no linked page yet.
Work→Plan switching needs a defined fallback for that case (below), not a
blocker on the design.

## Q1 — What UI switches modes

A three-way segmented control (Plan / Work / Review) in the sidebar's header
area, next to `WorkspaceSwitcher` — the one place structurally common to
every route today. Not a tab strip on any individual page (the roadmap
explicitly rules that out), and not per-page — one switcher, always visible,
regardless of which underlying route is currently rendered.

Each mode highlights based on the current pathname (same pattern the sidebar
already uses for Tasks/Agents/Inbox active-state), so it stays visually
correct even when the user navigates by clicking a page/task link directly
rather than through the switcher itself.

## Q2 — What carries across a switch

A "current focus" resolved from whatever's on screen right now, translated to
the equivalent destination in the target mode using the same entity-link
conventions that already exist:

- **Plan → Work**: if the current page has a task pointing at it
  (`Tasks.page` reverse lookup), land on that task's drawer
  (`/tasks?task={id}`). No linked task → land on Work mode's default (see Q4).
- **Plan → Review**: resolve the page's linked task (if any), then that
  task's most recent run (if any) → that run's review. No task, no run, or no
  file changes yet → Review mode's default (a list, not a dead end — see Q4).
- **Work (task X) → Plan**: `Tasks.page` for X, if set → its editor. Not set
  yet → Plan's default (workspace root / last-viewed page), not an error.
- **Work (task X) → Review**: X's most recent run's review, same resolution
  `task-drawer.tsx` already does today, generalized into the shared
  resolver. No run yet → Review mode's default.
- **Review (run R) → Work**: R's `taskId` (already on the `Run` type) → that
  task's drawer. R has no task (a page-scoped run, P6.1/6.2) → falls through
  to Plan instead (see next bullet), since Work has nothing to show it.
- **Review (run R) → Plan**: R's `taskId`'s linked page, or — for page-scoped
  runs — `run.pageId` directly (already on the `Run` type from P6.1) → that
  page's editor.

This is deliberately all *derived*, not stored: given the current route,
compute the best next-mode URL and navigate. No new persisted "what am I
looking at" state is needed beyond what the URL already encodes.

## Q3 — Persisted preference or URL-driven

URL-driven, not a hidden preference — matching every existing piece of
navigation state in this app (the sidebar's active-link highlighting, the
`?task=` deep link convention, `hrefForEntity`'s outputs). A mode is
reconstructible from the current pathname alone:

- `/p/*` → Plan
- `/tasks` or `/inbox` → Work
- `/runs/*/review` → Review

One narrow exception, matching an existing precedent rather than introducing
a new one: *which* Work sub-view (inbox vs. board) to land on when switching
**into** Work mode from Plan or Review needs one bit of memory (there's no
single "Work" URL today — it's two routes). Store "last visited Work
sub-route" in the same `localStorage` key space the sidebar already uses for
its own UI state (`notionforge:sidebar:{workspaceSlug}`) — not a new
persisted-preference system, just one more field in an existing one.

## Q4 — New UI vs. reuse

**Reused as-is, zero changes:** the doc editor, the task board, the task
drawer, the inbox page, the review panel. All of Plan's and most of Work's
and Review's actual content already exists.

**New, small:**
1. The switcher component itself (segmented control + active-mode detection
   from pathname + the cross-mode resolver from Q2). Lives in/near
   `components/sidebar/sidebar.tsx`.
2. A **Review mode landing/list view** — today `/runs/[runId]/review`
   requires a specific run id; there's no "here are your reviews" page to
   land on when switching into Review mode with nothing specific in context.
   This is genuinely missing, not just unwired — but small: the Inbox page's
   existing `listReviewReadyRuns` query is already exactly this list, just
   rendered as one section of a different page. A dedicated
   `/workspace/[slug]/review` route reusing that query is the natural shape.
3. Generalizing `hrefForEntity` to cover `run` (Review) and the
   task↔page↔run resolution chains in Q2 — currently ad-hoc in
   `task-drawer.tsx` and the Inbox page; worth centralizing once three
   call sites (switcher, inbox, task drawer) need the same logic, per this
   codebase's own stated reason for `hrefForEntity` existing in the first
   place ("the lookup logic lives here once instead of being duplicated per
   call site").

**Not needed:** no new route restructuring (`/p/[id]`, `/tasks`, `/inbox`,
`/runs/[id]/review` all keep their current paths — modes are a navigation
layer on top, not a URL migration), no new persisted server-side state, no
new trigger/automation infrastructure (per the already-decided
always-human-initiated answer).

## Proposed minimal implementation plan (for the follow-up build task)

1. `lib/entity-links.ts` — add a `run` case to `hrefForEntity`, and export the
   Q2 cross-mode resolution helpers (`planHrefForTask`, `reviewHrefForTask`,
   `workHrefForPage`, etc.) so the switcher, Inbox, and task drawer can share
   one implementation instead of three.
2. New `app/(app)/workspace/[workspaceSlug]/review/page.tsx` — the Review
   landing list, built on `listReviewReadyRuns` (already exists, currently
   only called from the Inbox page).
3. New `components/sidebar/mode-switcher.tsx` — the three-way control,
   pathname-based active detection, calls the Q2 resolvers on click, falls
   back to each mode's default route when there's nothing to resolve to.
4. `components/sidebar/sidebar.tsx` — mount `<ModeSwitcher>` next to
   `WorkspaceSwitcher`; extend its existing `localStorage` blob with the one
   new "last Work sub-route" field from Q3.
5. No changes to `BlockSuiteEditor.tsx`, the task board, the task drawer, or
   the review panel themselves — they're reused, not modified.

Everything above is additive (new files + two small extensions to existing
ones); nothing needs to be torn out or migrated to build this.
