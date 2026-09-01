## NotionForge

A fast, self-hosted, Notion-like collaborative workspace, built on Next.js 15 (App Router) and Payload CMS 3.0 with PostgreSQL.

The project structure, dependencies, and Payload CMS configuration are in place. The Notion-like shell — collapsible sidebar with a real page tree, workspace switcher, Cmd+K search (local stub), favorites, trash, and the page canvas (breadcrumbs, icon/cover, full width, lock) — is implemented under `app/(app)`. The block editor, Teable integration, and sync APIs are implemented in later phases.

### Stack

- **Framework:** Next.js 15 (App Router, TypeScript), Tailwind CSS
- **Backend:** Payload CMS 3.0 (`@payloadcms/next`, `@payloadcms/db-postgres`), mounted at `app/(payload)`
- **Database:** PostgreSQL
- **Rich text:** `@payloadcms/richtext-lexical`

### Collections

- `users` — auth-enabled, with `role` (`admin` / `member`)
- `workspaces` — `name`, `slug`, `icon`, `owner`, `members`
- `pages` — nested document tree (`parentPage`, `position`), `docState` (editor snapshot), `plainTextContent`, favorite/archive flags, `isFullWidth`/`isLocked` view flags
- `teable-databases` — links a workspace to an embedded Teable table

### Getting started

1. Copy `.env.example` to `.env` and point `DATABASE_URI` at a PostgreSQL instance; set a real `PAYLOAD_SECRET`.
2. Install dependencies: `npm install`
3. Run the dev server: `npm run dev`
4. Open [http://localhost:3000](http://localhost:3000) for the app, or [http://localhost:3000/admin](http://localhost:3000/admin) for the Payload admin panel (creates the first admin user on first visit).

### Other scripts

- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run generate:types` — regenerate `payload-types.ts` from the collection configs
- `npm run generate:importmap` — regenerate the Payload admin import map after adding custom admin components
# NotionForge

## MCP server

Run `npm run mcp:notionforge` from the project root to expose NotionForge's Teable and page operations over stdio. The canonical app must be running at `http://localhost:3000`; set `NOTIONFORGE_URL` to override it. Configure a client such as Claude Desktop with:

```json
{ "mcpServers": { "notionforge": { "command": "npm", "args": ["run", "mcp:notionforge"], "cwd": "C:/path/to/notionharness" } } }
```

The server provides `list_teable_tables`, `get_table_schema`, `query_records`, `create_record`, `update_record`, `delete_record`, `get_page`, and `update_page_content`. Tool failures are returned as MCP error results; the Teable API key stays server-side in the app.
