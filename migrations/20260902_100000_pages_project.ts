import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// ROADMAP B-1 (project detail, Pages tab) — prepared, NOT applied. A
// project-scoped page tree needs `pages` to know which project it belongs
// to; today it only has `parentPage` (confirmed absent again this batch,
// same finding as B-0's navigation investigation). This is the additive
// migration for that field, following the exact pattern already used for
// `tasks.agent`/`tasks.page` (single relationship => one nullable FK column
// + index, `ON DELETE SET NULL` so deleting a project never cascades into
// deleting its pages).
//
// Deliberately NOT run against the live DB (see the hard rule this batch
// was built under) and deliberately NOT paired with a `collections/Pages.ts`
// field addition in this same change: `payload.config.ts` has `push: false`
// specifically so schema and DB never drift, and this app rebuilds
// (`npm run build && npm run start`) on every container restart with no
// migration-gate in front of it — declaring the field in the collection
// config before this migration is actually applied would make the very
// next rebuild query a `project_id` column that doesn't exist yet and break
// every `pages` read. A human must add the field to `collections/Pages.ts`
// AND run this migration together, not as two separate steps.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "pages" ADD COLUMN "project_id" integer;
    ALTER TABLE "pages" ADD CONSTRAINT "pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX "pages_project_idx" ON "pages" USING btree ("project_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX "pages_project_idx";
    ALTER TABLE "pages" DROP CONSTRAINT "pages_project_id_projects_id_fk";
    ALTER TABLE "pages" DROP COLUMN "project_id";
  `)
}
