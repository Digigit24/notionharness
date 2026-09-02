import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// ROADMAP B-4 "Work" (bulk actions' "Archive" verb) — prepared, NOT applied,
// and deliberately NOT paired with a `collections/Tasks.ts` field addition in
// this same change. Same reasoning `migrations/20260902_100000_pages_project.ts`
// already documented for `Pages.project`, applied here just as hard: `tasks`
// is read on every board/list/table load (`app/(app)/workspace/[workspaceSlug]/
// tasks/page.tsx`'s per-column `payload.find`), so declaring `archived` in the
// collection config before this migration actually runs would make the very
// next rebuild query a column that doesn't exist and break every task read,
// workspace-wide. A human must add the field to `collections/Tasks.ts` AND
// run this migration together, not as two separate steps.
//
// Until then, the bulk "Archive" action (components/tasks/bulk-action-bar.tsx)
// deliberately does NOT write this column — it reuses the workspace's
// existing 'cancelled'-category task status (collections/TaskStatuses.ts's
// fixed vocabulary already includes it) as an honest, immediately-functional
// stand-in, and disables itself with an explanatory tooltip if the workspace
// has no such status configured. See that component's own comment and this
// batch's final summary for the exact human follow-up once this column
// exists: swap the bulk action (and a default "hide archived" view filter)
// over to a real `archived` boolean.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "tasks" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;
    CREATE INDEX "tasks_archived_idx" ON "tasks" USING btree ("archived");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX "tasks_archived_idx";
    ALTER TABLE "tasks" DROP COLUMN "archived";
  `)
}
