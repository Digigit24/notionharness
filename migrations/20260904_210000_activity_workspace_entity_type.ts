import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// People management writes its audit rows into the same polymorphic `activity`
// table every other timeline in the product uses — invite sent, invite
// accepted, invite revoked, role changed, member removed — which needs
// `workspace` added to the `activity.entity_type` Postgres enum.
// `ACTIVITY_ENTITY_TYPES` in `collections/Activity.ts` already lists it; this
// is the DB-side half.
//
// A membership change is not a change to a task, a project, a page or a run, so
// none of the four existing values could carry it honestly. The rejected
// alternative was a separate `membership_events` table: it would have been a
// second audit mechanism alongside the one whose whole purpose is not needing a
// schema change per entity kind, and the workspace-wide audit view would then
// have had to read two tables and interleave them by timestamp.
//
// Postgres cannot drop a single enum value (there is no
// `ALTER TYPE ... DROP VALUE`), so `down()` cannot cleanly reverse this in
// isolation — a no-op with an explanation, exactly as
// `20260902_060000_followers_page_entity_type.ts` handles the same situation.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_activity_entity_type" ADD VALUE IF NOT EXISTS 'workspace';`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // Intentionally a no-op — see comment above.
  void db
}
