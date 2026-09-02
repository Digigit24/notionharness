import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// ROADMAP B7.2 (Batch B-6 "Finish") — "a spend cap with a fail-closed
// option." Confirmed absent from the schema: neither `collections/Workspaces.ts`
// nor `collections/Agents.ts` has any spend-limiting field today. This is
// the additive migration for a workspace-level cap (nullable integer cents,
// NULL = uncapped) — same shape as `run_usage.cost_ticks` elsewhere in this
// codebase, just at the workspace grain.
//
// Deliberately NOT run against the live DB (this batch's hard rule) and
// deliberately NOT paired with a `collections/Workspaces.ts` field addition
// in this same change — same reasoning as `migrations/20260902_100000_pages_project.ts`:
// `payload.config.ts` has `push: false` specifically so schema and DB never
// drift, `workspaces` is read on nearly every page load
// (`getWorkspaceBySlug`), and this app rebuilds on every container restart
// with no migration gate in front of it. Declaring the field in the
// collection config before this migration actually runs would make the
// very next rebuild query a `spend_cap_cents` column that doesn't exist and
// break every workspace read in the app. A human must add the field to
// `collections/Workspaces.ts` AND run this migration together, not as two
// separate steps — exactly the precedent above.
//
// SCOPE NOTE (see this batch's final summary): only a workspace-level cap
// is prepared here, not a per-agent one — `agents` is read just as often
// (`agents/page.tsx`, every task/run read that resolves an agent), so a
// per-agent cap needs the identical up-front discipline and was set aside
// to keep this migration reviewable as one clear step. Dispatcher-side
// enforcement (refusing to claim/execute a new run once a workspace is over
// budget) is a real, separate gap — not built here, not implied by this
// migration existing. See the Settings page's own copy for the same note
// surfaced to a human operator.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "workspaces" ADD COLUMN "spend_cap_cents" integer;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "workspaces" DROP COLUMN "spend_cap_cents";
  `)
}
