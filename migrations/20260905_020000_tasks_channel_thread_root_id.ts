import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// R14-P0.8 — "a task is a thread." The whole schema change this unit makes:
// one nullable column on `tasks` pointing at a broker `team_messages.id`
// (BIGSERIAL — see lib/broker/migrations/0009_teams.sql), the same
// cross-boundary pattern `migrations/20260904_200000_access_and_connectors.ts`
// already used for `invitations.channel_id` (also a bare `bigint`, no FK,
// because the referenced table lives in the raw-pg broker rather than in
// Payload's own schema — see that field's own comment in
// `collections/Invitations.ts` for why a `relationship` field cannot do this).
//
// Deliberately NOT `team_tasks.id` and NOT a second column per the roadmap's
// own boundary decision: `tasks` (this table) is a project task; `team_tasks`
// is the broker's own lightweight coordination item; the two are never
// merged, so this column only ever holds a `team_messages.id`.
//
// Hand-written and applied via `scripts/apply-tasks-channel-thread-root-id-migration.ts`
// rather than `payload migrate`, for the same reason every migration since
// `20260902_090000_approvals` has been: `payload migrate`/`migrate:create`
// hang non-interactively against this dev database (see that migration's own
// comment, and `migrations/20260905_010000_media.ts`'s).
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "tasks" ADD COLUMN "channel_thread_root_id" bigint;
    CREATE INDEX IF NOT EXISTS "tasks_channel_thread_root_id_idx" ON "tasks" USING btree ("channel_thread_root_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS "tasks_channel_thread_root_id_idx";
    ALTER TABLE "tasks" DROP COLUMN IF EXISTS "channel_thread_root_id";
  `)
}
