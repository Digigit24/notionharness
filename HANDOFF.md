# Handoff — TASK-6 (Sync & Markdown Bridge APIs)

Written 2026-08-31 by Mika (Multica agent) for continuation in a local Claude CLI session.
Issue: **TASK-6** (`01a05921-ef86-76be-9d58-7054fea52d79`), status **`in_review`**, parent project **Notion Harness** (`01a058ba-594b-771b-a5a5-6c2a3db05b8d`).

## Where things stand

Stages 1–3 of the parent project are done/in_review:

- **TASK-4** (Shell & Navigation UI) — `done`
- **TASK-5** (BlockSuite Document Editor Integration) — `done`
- **TASK-6** (this issue: Sync & Markdown Bridge APIs) — `in_review`, delivered and verified, awaiting your acceptance
- **TASK-7** (Custom Teable Database Block) — `backlog`, blocked on a Teable instance/credentials. **Not started, not touched.**

This repo is **not a git repository** (no `.git`) — there's nothing to branch/PR/diff against; all changes below are just sitting in the working tree.

## What TASK-6 delivered

New shared server-side doc utility:
- `lib/blocksuite-doc.ts` — headless BlockSuite `DocCollection`/`Doc` setup (mirrors `components/editor/BlockSuiteEditor.tsx`'s hydration logic, minus the browser-only `effects()` calls). Exports `loadDoc`, `encodeDocUpdate`, `extractPlainText`, `docToMarkdown`, `markdownToDoc`, `applyDocSync`.

New API routes:
- `app/api/pages/[id]/sync/route.ts` — `POST { update: base64 }` → saves `docState` + re-derives `plainTextContent`.
- `app/api/pages/[id]/export-markdown/route.ts` — `GET` → Markdown with frontmatter (`title`, `exportedAt`).
- `app/api/pages/[id]/import-markdown/route.ts` — `POST` (raw markdown body or `{ markdown }` JSON) → parses into blocks, updates `docState`/`plainTextContent`/`title`.
- `app/api/search/route.ts` — `GET ?q=&workspaceId=` → Payload `where` query over `title`/`plainTextContent` (Postgres `ILIKE` via `like` operator), excludes archived.

Wiring/edits to existing files:
- `app/(app)/actions.ts` — `syncPageDoc` Server Action (the live editor's 500ms autosave target) now calls the shared `applyDocSync` helper, so `plainTextContent` stays fresh from every keystroke, not just from the new REST route.
- `lib/search.ts` — rewritten from a local-array stub to an async `fetch('/api/search?...')` call.
- `components/sidebar/search-modal.tsx` — now debounces (200ms) and calls `searchPages(query, workspace.id)`; dropped the now-unused `pages` prop.
- `components/sidebar/sidebar.tsx` — dropped the `pages={pages}` prop passed into `SearchModal` (one line).

**Bug found + fixed during review** (flagged by @Ritik: "h1 is not bigger than h2"):
- Root cause: `@toeverything/theme` (the package that defines BlockSuite's actual `--affine-font-h-1..6` / `--affine-quote-color` / etc. CSS custom-property **values**) was only a transitive dependency and its `style.css` was never imported anywhere. Every block-level design token was undefined, so headings/quotes/code/dividers all lost their intended styling, not just heading sizes.
- Fix: added `@toeverything/theme` as a direct dependency (`package.json` + `package-lock.json`) and added `import "@toeverything/theme/style.css"` to `app/layout.tsx` (before `globals.css`).
- Verified by fetching the actual compiled `layout.css` served to the browser post-fix: `--affine-font-h-1: 28px`, `h-2: 26px`, `h-3: 24px`, `h-4: 22px`, `h-5: 20px`, `h-6: 18px` — all distinct now, plus quote/code/divider colors resolve correctly too.

## Verification performed (all against the live running app, not just typecheck)

- Export → import that same Markdown back → re-export was **byte-identical** (only the `exportedAt` timestamp differed).
- Built a fresh Yjs update out-of-band, POSTed to `/sync` — `docState`/`plainTextContent` updated correctly and round-tripped.
- `/api/search` matched on both title and body text; `[]` for non-matching queries.
- `/workspace/demo` and `/workspace/demo/p/1` kept returning 200 and mounting cleanly after every write.
- `npx tsc --noEmit` and `eslint` clean on all changed/added files.
- Demo page 1 (`/workspace/demo/p/1`) was left with a **clean sample doc** (via `import-markdown`) covering all supported block types — heading, paragraph, quote, todo list, code, divider — as a live demonstration, replacing earlier test filler content.

## Running / dev environment gotchas

- The app runs in a Docker container named **`notionforge-app`** (port 3000, bind-mounted to this directory — edits to files here are live inside the container immediately, no rebuild needed for source changes). A **second** container, `notionforge-postgres`, is also running locally but is **not** what the app actually talks to.
- `.env`'s `DATABASE_URI` points to a **hosted Supabase Postgres** instance, not the local `notionforge-postgres` container — don't waste time debugging data issues against the local Postgres container, it's unused by this app.
- `notionforge-app`'s `node_modules` and `.next` are Docker **named volumes**, installed once at container creation. If you add/change npm dependencies (like the `@toeverything/theme` fix above), you need to `docker restart notionforge-app` — its startup command is `npm install && npm run dev -- -H 0.0.0.0`, so a restart re-triggers `npm install` and picks up new deps. A plain file edit does **not** need a restart; a `package.json` change does.
- No `curl` inside the container — if you need to test from inside it, use Node's `fetch`/`http`, or run `curl` from the host against `localhost:3000` (ports are published).
- To run a one-off Node/tsx script against the installed BlockSuite packages, the script file must physically live under `/app` inside the container (module resolution fails from `/tmp` due to how `tsx`/Next resolve node_modules).
- Payload's REST API (`/api/pages`, `/api/workspaces`, etc.) requires normal Payload access/auth — it will 403 for anonymous requests. All app-internal code paths use the Local API (`getPayloadClient()` + `overrideAccess: true`) instead, bypassing that; keep following that pattern for any new server-side code.

## Known follow-ups / things worth a second look

- The Markdown export/import is a **hand-rolled serializer** (walks `affine:*` block flavours directly), not an official BlockSuite adapter — none is publicly exported in the installed `0.19.5` packages (`MarkdownAdapter` etc. are internal, not in the package `exports` map). It covers everything TASK-5's editor can currently produce (paragraph/h1-h6/quote, bulleted/numbered/todo lists, code, divider). **If TASK-7 or any future stage adds new block types** (e.g. the Teable database block), `lib/blocksuite-doc.ts`'s `serializeChildren`/`markdownToDoc` will need a matching `case` added, or those blocks will silently be skipped on export.
- Nested/indented lists round-trip at the data level (recursive walk supports depth), but the Markdown import parser is intentionally flat (doesn't re-derive nesting from leading whitespace) — fine for what the slash menu currently produces, worth revisiting if deep nesting becomes a real use case.
- I did not commit anything (no git repo here) — if you want version control, `git init` + first commit is still outstanding for the whole project.

## Next task (parked, not started)

**TASK-7 — Custom Teable Database Block Integration** (`01a05921-f885-7c50-8c05-13283ee4de06`), status `backlog`. Explicitly blocked on external setup: needs a running Teable instance (self-hosted via Docker, or Teable Cloud) and `TEABLE_API_URL`/`TEABLE_API_KEY` credentials, handed off through the workspace's own secret handling — not pasted into a comment/file. Nothing has been done on it. Someone needs to stand up Teable and provide credentials before it can be promoted to `todo`.

---
Stopping here per instruction — no further tasks started. This file can be deleted once you've absorbed it; it was written for continuation purposes only, not as a permanent project doc.
