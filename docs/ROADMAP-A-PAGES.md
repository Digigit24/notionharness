# Roadmap A — Pages, BlockSuite, Notion parity

Repo: E:\Digitech\softwares\notionharness. Verify with `npx tsc --noEmit`, `npx eslint <files>`, and `npm run build`. Restart with `npm start` on port 3000 and check in a browser before calling anything done.

## Pillar A1 — The agent-session block (the USP)

The whole product thesis: a Slack thread, a Notion page and an agent conversation collapse into one object. Today they are three.

Everything needed already exists and is proven three times over.

- Custom blocks already work: `affine:embed-run-card` (`components/editor/blocks/run-card/*`), `affine:embed-task` (`blocks/task/*`), and the native database block. Each is `defineBlockSchema` + `FlavourExtension` + `BlockViewExtension`, registered in `BlockSuiteEditor.tsx` (schemas ~line 146, specs ~178-200, custom-element effects ~46-59).
- Mounting React inside a Lit block is already solved: `blocks/task/task-block.ts:49-66` creates a React root into a Lit-managed div via `ref()` and unmounts in `disconnectedCallback`.
- BlockSuite is pinned at 0.19.5 across all `@blocksuite/*` packages.

A1.1 Add block `notionforge:agent-session`, copying `blocks/task/*` exactly.
  - `schema.ts` props `{ sessionId: null, agentId: null, projectId: null, worktreeId: null, collapsed: false }`, `parent: ['affine:note']`, `children: []`.
  - `spec.ts` (two lines), `effects.ts` (`customElements.define`).
  - Lit `agent-session-block.ts` mounting a React `AgentSessionBlockView`.
  - Register in `BlockSuiteEditor.tsx` in all three places.

A1.2 `AgentSessionBlockView` renders the existing `Thread` from `@/components/hermes` in a bounded, rounded, scrollable card (max-height ~420px) with a composer. Reuse `getSessionSnapshots` and `sendSessionMessage` from `work/actions.ts`. Do not fork the Thread component; pass a `compact` prop if needed.

A1.3 Expand control on the block header opens `/work?session=<id>` — the same session, full screen. The block and the Work page are two views of one row.

A1.4 Persist: when the block is created it calls `createWorkSession` and writes the returned id into the block prop. The page then holds that session forever, because the id lives in the document.

## Pillar A2 — Wire the @ mention (currently inert)

The chip renders and even polls for an active run, but there is no click handler anywhere. `components/editor/mentions/mention-node.ts:98-110` renders a span; its own comment at line 14 admits "Non-interactive v1 chip". The agent id is already persisted in the delta (`mentions/schema.ts:23-31`), so only the handler is missing.

A2.1 Add a click handler to `AffineMention` for `kind === 'agent'`.
A2.2 On click: insert an `notionforge:agent-session` block directly after the paragraph containing the mention, bound to that agent, and focus its composer. This is the "@ agent starts a session right here" behaviour.
A2.3 If a session block for that mention already exists on the page, scroll to it instead of creating a second one.
A2.4 Person and page mentions keep their current inert behaviour; do not change them.

## Pillar A3 — Chat to page, and back

A3.1 Add "Convert to page" on an assistant message in `components/hermes/Message.tsx` (an action in the existing hover row). It creates a page whose title is the first line of the reply and whose body is the message content, then links back to the session.
A3.2 Reuse the transcript-to-blocks path that already exists in `lib/transcript/*` rather than writing a new serializer.
A3.3 Rich content survives the conversion: tool calls, terminal output and diffs render as the existing block types where possible, and as fenced code blocks otherwise. A plain-text dump is not acceptable.
A3.4 A page created this way sets `project` from the session, so it appears in the project's Pages tab automatically.

## Pillar A4 — The two bugs you named

A4.1 Table row pages titled `Record <opaque id>`.
  - Single source: `app/api/pages/for-database-record/route.ts:59`, `title: \`Record ${recordId}\``.
  - Fix: load the row and its database's fields before `create`, resolve the primary field the same way `data-sources/user-database-data-source.ts:195-199` and `payload-data-source.ts:61` do, and use that cell's value as the title. Fall back to `Untitled row` when the cell is empty, never to the id.
  - Keep the title in sync: when the primary cell changes, update the paired page title (or resolve the title on read, which is simpler and cannot drift).

A4.2 Inner pages appear at the sidebar root.
  - Cause: `lib/pages-cache.ts:25-34` fetches every page with no filter, and only `createPage` (`app/(app)/actions.ts:117`) ever sets `parentPage`. Row pages (`for-database-record/route.ts`) and task documents (`lib/task-pages.ts:21-25`) omit it, so `lib/tree.ts:22` treats them as roots.
  - Fix: exclude row-paired pages from the tree using the `linkedSourceType`/`linkedSourceId` fields that already exist on Pages, and exclude task documents by joining through `tasks.page` or by setting a marker on creation.
  - `isFavorite` already exists and already powers a Favorites section (`sidebar.tsx:229`) — use it as the pin mechanism rather than adding a new field.
  - A page reachable only through a table or a task is still reachable: from its row, from its task, and from search.

## Pillar A5 — Page polish

A5.1 Record detail pages get a real header: primary-field title, the database it belongs to, and a back link to the table.
A5.2 Breadcrumbs on `agents/[agentId]`, `tasks/[taskId]` and `projects/[projectId]`, copying the pattern the agents list page comment explicitly invites.
A5.3 A page created from a task or a row shows where it came from, so a page is never orphaned from its context.

## Free wins, all pages (do these first; they are minutes each)

1. `settings-rail.tsx` — add a link to `/settings/notifications` (currently in no navigation anywhere).
2. `sidebar.tsx` SECTION_LINKS — add `/review` and `/active-runs`; remove the stale "Ask" comment.
3. `settings/health/page.tsx` — make the six tiles links: active runs, queue depth, runtimes, spend.
4. `runs/[runId]/review` — render `run.sessionId` as a link to `/work?session=<id>` and `run.pageId` to `/p/<id>`; add cost via the existing `getRunUsageTotals`.
5. `review/page.tsx` — batch-resolve agent and page names instead of printing `#id`; add a completion timestamp; use `EmptyState` and the `entity-links.ts` helpers rather than hand-rolled strings.
6. `inbox/page.tsx` — `<a>` to `<Link>`; item count in the header; advertise the j/k/y/n/r/e shortcuts that are already registered; give "Inbox zero" an action.
7. `page.tsx` (home) — show `usage7d.runCount` and `totalTokens` next to the cost; delete the bespoke `elapsedSince` in favour of the already-imported `formatRelativeTime`; link the cost section to health.
8. `agents/page.tsx` — surface `runCount` from the weekly rollup, not only cost.
9. `projects/page.tsx` — task count, active-run count and last activity on rows; wire the add form into the empty state.
10. `audit/page.tsx` — collapse the JSON payload behind `<details>`; add a "Clear filters" action on the filtered empty state.
11. `active-runs/page.tsx` — fix the copy (page- and session-scoped runs are filtered out but the header claims otherwise); use theme tokens instead of hardcoded grays; use `getWorkspaceBySlug` + `notFound()`.
12. `settings-rail.tsx` — fix the "Name, spend cap" hint (there is no name field) and the contradictory MCP-catalog hint.
13. Add the shared `ProfilePills` switcher to `settings/model|skills|mcp|safety` consistently, and to `providers`.
14. `tasks/page.tsx` — accept `?project=` and filter the already-loaded columns.

## What the competition proves is worth building

Multica AI is the closest competitor: an open-source, self-hostable platform where coding agents are first-class assignees on Linear-style issues, driving 26 agent CLIs through a local daemon. Its object model is Workspace, Project, Issue, Run. Crucially it has **no block editor**. That is the seam this product occupies, and the reason the agent-session block above is the whole thesis rather than a nice-to-have. (Its GitHub license reads NOASSERTION, so treat "open source" as unconfirmed.)

Notion AI shipped the shape worth copying: an AI block that is persistent and re-runnable, takes specified context plus inline mentions, and since August 2026 can suggest edits for one-at-a-time approval instead of applying them. Two ideas follow directly.

- **A1.5 Persistent, re-runnable block.** The agent-session block should keep its output and offer Run again, rather than being a transcript that only grows.
- **A3.5 Suggest edits, do not apply them.** Agent page writes get a `proposed` state rendered as per-block proposals a human accepts or rejects. The daemon page-writes endpoint already exists; this adds a state, not a mechanism.

Multica also surfaces two honesty affordances worth stealing outright.

- Its docs say plainly that a completed run "does not confirm the issue's goal has been met". Our transcript should draw the same distinction between a turn that ended and a goal that was achieved.
- It queues messages typed while an agent is working, and it surfaces edit conflicts when an agent changed something a human was editing. Both matter more here than in an issue tracker, because a human and an agent can be editing the same page.
