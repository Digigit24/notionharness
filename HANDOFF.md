# Handoff — NotionForge

Written 2026-09-01. Compact reference for continuation — not exhaustive, see git history / `docs/notion-parity-audit.html` for deeper context.

## Environment

- App: **production build**, not dev mode. Container `notionforge-app`, port 3000. Entrypoint runs `npm install && npm run build && npm run start` on every start — **source edits do NOT hot-reload**. After any code change: `docker restart notionforge-app` and wait ~2min for the rebuild.
- If a rebuild ever crashes with a no-stack-trace error right after "Creating an optimized production build": stale `.next` cache (named volume `notionforge-next-cache`). Fix: `docker exec notionforge-app sh -c "rm -rf /app/.next/*"` then restart.
- **DB safety rule**: never run a standalone script that calls `getPayloadClient()` against the shared Supabase DB — `payload.config.ts` has `push: false` now (prevents auto schema-push), but a script with actual schema drift can still hang/prompt. Verify through the live container instead.
- Teable self-hosted at `http://localhost:3100` (separate `teable-selfhost` Docker stack). From inside `notionforge-app`, reach it via `host.docker.internal:3100`, not `localhost`. Two credentials in `.env`: `TEABLE_API_KEY` (narrow, day-to-day CRUD) and `TEABLE_API_KEY_CREATOR` (broader, table/base creation only) — deliberately separate, don't merge.

## What's done

- **Auth**: Better Auth (own tables, separate from Payload's `users`), dark/light mode, pushed to `github.com/Digigit24/notionharness`.
- **Database engine**: Teable as headless data source (no iframe, ever — locked decision). Two block types exist:
  - `affine:embed-teable-database` (boxed, custom-rendered) — older, still works, not the primary path anymore.
  - `affine:embed-teable-native` (**the real one**, slash menu: type `/Database`) — forks BlockSuite's actual `DataViewBlockComponent` + a custom `TeableDataSource extends DataSourceBase`, so Table/Kanban/Calendar views are BlockSuite's genuine native UI, not hand-rolled. BlockSuite's own disconnected native commands are hidden from the slash menu to avoid confusion.
- **Relations**: real Teable `link` fields, generalized to any two tables in a workspace, working both directions.
- **Rows-as-pages (v1)**: every Teable record can pair with a real Payload `pages` doc (`linkedTeableTableId`/`linkedTeableRecordId`). Row-click opens BlockSuite's own native `RecordDetail` panel (not a custom one) in a side drawer, with a real BlockSuite editor mounted for the row's content. Hover-expand icon on the title column works (was broken — BlockSuite's icon only renders on a column matching a special `'title'` property type, which Teable has none of; fixed by pointing it at Teable's primary field).
- **@mentions**: real BlockSuite inline-mention primitive, wired to Better Auth's real user list via `/api/users`.
- **MCP server**: `scripts/notionforge-mcp.ts`, 8 tools wrapping the Teable proxy + page markdown import/export.
- **Sandbox orchestrator**: `lib/sandbox/*`, Docker-per-session isolation via `dockerode`, verified (16/16 real isolation checks) — not wired into any UI yet, infra only.
- **Optimistic UI**: sidebar page creation, full-width/lock toggles — instant local state, background persistence.
- Known recurring CSS gotcha (fixed where found so far): BlockSuite's Lit components inject **unlayered, unscoped global CSS** into `<head>` (their own architecture choice — "shadowless" for editor performance). Per CSS cascade-layers spec, any unlayered rule beats Tailwind's layered utilities regardless of specificity. Fix pattern used repeatedly: a targeted class + `!important` in `app/globals.css` (see `.page-canvas-title`, `affine-menu .affine-menu-body`). If something looks subtly wrong (size, spacing, alignment) on an element that sits near BlockSuite in the DOM, suspect this mechanism first.

## What's next (agreed, not yet dispatched)

1. **View Settings panel** — consolidate property visibility (new), filter/sort (exists inline, migrate in), group (exists on Kanban, generalize to Table), copy-link, data-source section. Explicitly **not** doing Automations/AI Autofill (no such engine in this stack) or Conditional color (needs a Teable-support check first).
2. **Relations → RecordDetail**: clicking a relation chip should open the related record's real detail panel (same `openRecordDetailPanel` already built for the hover-icon), not just the current link/unlink picker.

## Parked, not started

- Hermes Gateway / AG-UI / CopilotKit chat integration — paused by explicit user request, needs a fresh feasibility spike (does Hermes Gateway's `/v1` stream match AG-UI's protocol) before resuming.
- Full Notion parity gaps not yet built: formula/rollup properties, Gallery/List/Timeline views, toggle/callout blocks, templates, comments, page history, granular permissions. Full breakdown with priorities: `docs/notion-parity-audit.html`.

## House rules that mattered all session

- Verify against Teable's **live OpenAPI spec** (`/docs-json` on the running instance), never guess endpoint shapes — several bugs (record PATCH shape, filter/sort using PUT not PATCH, field type-change needing a separate `/convert` endpoint) only surfaced by checking the real spec.
- `tsc --noEmit` + `eslint` clean does **not** guarantee `npm run build` succeeds (Next.js's SWC bundler is stricter, e.g. rejects certain decorator syntax TS tolerates). Always run a real build before calling a task done.
- No browser access exists anywhere on this team — verification is API/DB/source-level. Flag pixel-level claims as unconfirmed rather than asserting them.
