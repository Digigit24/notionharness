# Handoff — NotionForge

Written 2026-09-01, reconciled the same day against `docs/ROADMAP.html` Pillar 1.2 — every claim below was re-verified live (git remote, Docker volume mounts, `.env` keys, file/line counts) rather than carried forward assumed. Compact reference for *current feature status*; for the decisions and environment rules that outlive any one status snapshot, see `AGENTS.md` (durable, hand-maintained section below its auto-generated Next.js block). Not exhaustive — see git history / `docs/notion-parity-audit.html` for deeper context.

## Version control

Git is initialized, first commits pushed to `github.com/Digigit24/notionharness` (confirmed: `origin` remote present, `remotes/origin/main` exists). Pillar work happens on `roadmap/*` branches via per-pillar worktrees, not directly on `main` — as of this writing `roadmap/foundation`, `roadmap/datasource`, `roadmap/editor-hardening`, `roadmap/hermes-acp`, and `roadmap/ui-foundation` all exist in parallel.

## Environment

- App: **production build**, not dev mode. Container `notionforge-app`, port 3000. Entrypoint runs `npm install && npm run build && npm run start` on every start — **source edits do NOT hot-reload**. After any code change: `docker restart notionforge-app` and wait ~2min for the rebuild.
- If a rebuild ever crashes with a no-stack-trace error right after "Creating an optimized production build": stale `.next` cache (named volume `notionforge-next-cache`). Fix: `docker exec notionforge-app sh -c "rm -rf /app/.next/*"` then restart.
- **DB safety rule**: never run a standalone script that calls `getPayloadClient()` against the shared Supabase DB — `payload.config.ts` has `push: false` now (prevents auto schema-push), but a script with actual schema drift can still hang/prompt. Verify through the live container instead.
- **Database engine decision (2026-09-02):** Teable has been retired in favor of the native Postgres-backed UserDatabaseDataSource. This removes a second service, credential set, and network dependency while fitting the agentic-write architecture directly.

## What's done

- **Auth**: Better Auth (own tables, separate from Payload's `users`), dark/light mode, pushed to `github.com/Digigit24/notionharness`.
- **Database engine**: native Postgres-backed UserDatabaseDataSource (no external data service or iframe). New database blocks use the generic native database engine; legacy Teable blocks remain retained only for migration/read compatibility until a separately approved cleanup.
- **Relations**: native Postgres relation fields generalized to any two databases in a workspace.
- **Rows-as-pages (v1)**: every native database row can pair with a real Payload `pages` doc. Row-click opens BlockSuite's native `RecordDetail` panel in a side drawer, with a real BlockSuite editor mounted for row content.
- **@mentions**: real BlockSuite inline-mention primitive, wired to Better Auth's real user list via `/api/users`.
- **MCP server**: `scripts/notionforge-mcp.ts`, tools wrapping native database + page markdown import/export.
- **Sandbox orchestrator**: `lib/sandbox/*`, Docker-per-session isolation via `dockerode`, verified (16/16 real isolation checks) — not wired into any UI yet, infra only.
- **Optimistic UI**: sidebar page creation, full-width/lock toggles — instant local state, background persistence.
- Known recurring CSS gotcha (fixed where found so far): BlockSuite's Lit components inject **unlayered, unscoped global CSS** into `<head>` (their own architecture choice — "shadowless" for editor performance). Per CSS cascade-layers spec, any unlayered rule beats Tailwind's layered utilities regardless of specificity. Fix pattern used repeatedly: a targeted class + `!important` in `app/globals.css` (see `.page-canvas-title`, `affine-menu .affine-menu-body`). If something looks subtly wrong (size, spacing, alignment) on an element that sits near BlockSuite in the DOM, suspect this mechanism first.

## What's next (agreed, not yet dispatched)

1. **View Settings panel** — consolidate property visibility (new), filter/sort (exists inline, migrate in), group (exists on Kanban, generalize to Table), copy-link, data-source section. Explicitly **not** doing Automations/AI Autofill (no such engine in this stack) or Conditional color (needs a Teable-support check first).
2. **Relations → RecordDetail**: clicking a relation chip should open the related record's real detail panel (same `openRecordDetailPanel` already built for the hover-icon), not just the current link/unlink picker.

## Parked, not started

- Hermes Gateway / AG-UI / CopilotKit chat integration — this was paused pending a feasibility spike on the wire protocol; `docs/ROADMAP.html` Pillar 3 has since decided that question rather than left it open: `hermes acp` over stdio, normalized to a `RunEvent` contract, feeding assistant-ui's runtime directly (D6–D8, explicitly dropping AI SDK from the streaming path). Don't resume this as a "spike the protocol" task — it's Pillar 3/5.1 now, with a defined contract to build against.
- Full Notion parity gaps not yet built: formula/rollup properties, Gallery/List/Timeline views, toggle/callout blocks, templates, comments, page history, granular permissions. Full breakdown with priorities: `docs/notion-parity-audit.html`. The roadmap's own guardrails section explicitly scopes this down further — full Notion parity is called out as *not* a goal (cap the editor at what a task/spec needs).

## Current implementation additions (2026-09-02)

- **Approvals (P5.4):** `collections/Approvals.ts`, `lib/hermes/approval-helpers.ts`, ACP `permissionCallback`, and authenticated `GET`/`POST /api/approvals`; session identity is authoritative, never client headers.
- **Inbox (P5.5):** `app/(app)/workspace/[workspaceSlug]/inbox/page.tsx` combines pending approvals, failed runs, review-ready runs, and mentions.
- **Transcript (P5.6):** pure `lib/transcript/` passes normalize ordered RunEvents into redacted timelines, paired/grouped steps, lanes, and outcomes; `scripts/test-transcript-pipeline.ts` is the fixture test.
- **Hermes/dispatcher:** broker runs/events/usage, HTTP polling, worktrees/identity overlays, ACP permission policy, scoped page writes, and review surface are implemented. Session/usage/message/done was live-proven; auto-write-to-diff remains unconfirmed under flaky upstream services.
- **Migrations:** on the known interactive drift prompt, use a reviewed hand-written migration plus short-lived `pg.Pool` apply script and `payload_migrations` row; see `scripts/apply-approvals-migration.ts`.
- `master` mirrors `main` as the user-facing local-run branch (port 3000/3001). Aion CLI teammates/worktrees now replace the earlier OpenCode team; keep roadmap worktree and centralized verification discipline.

## House rules that mattered all session

- Verify against Teable's **live OpenAPI spec** (`/docs-json` on the running instance), never guess endpoint shapes — several bugs (record PATCH shape, filter/sort using PUT not PATCH, field type-change needing a separate `/convert` endpoint) only surfaced by checking the real spec.
- `tsc --noEmit` + `eslint` clean does **not** guarantee `npm run build` succeeds (Next.js's SWC bundler is stricter, e.g. rejects certain decorator syntax TS tolerates). Always run a real build before calling a task done.
- No browser access exists anywhere on this team — verification is API/DB/source-level. Flag pixel-level claims as unconfirmed rather than asserting them.
