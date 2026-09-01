import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// Follow-up to 20260902_040000_pillar2_system_tables — that migration hand-wrote
// `tasks.revision` as `bigint`, but `collections/Tasks.ts` declares it
// `type: 'number'`, which Payload's own postgres adapter maps to `numeric`
// everywhere else in this schema (see `position` on the same table). The
// mismatch matters because `node-postgres` returns `bigint` columns as JS
// strings by default (to avoid silent precision loss past 2^53), and the
// collection's `beforeChange` hook does
// `(typeof data.revision === 'number' ? data.revision : 0) + 1` — a string
// revision fails that `typeof` check and silently resets to 1 instead of
// incrementing. Not user-visible yet since nothing reads/writes revision
// outside the hook itself, but must be fixed before this surface starts
// depending on it for optimistic-concurrency checks.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tasks" ALTER COLUMN "revision" TYPE numeric;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tasks" ALTER COLUMN "revision" TYPE bigint USING "revision"::bigint;`)
}
