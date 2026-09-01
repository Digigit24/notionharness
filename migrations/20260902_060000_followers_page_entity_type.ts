import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// ROADMAP P2.6 — generalizing the activity spine to pages means pages can
// now be followed too (creator auto-follows a page on create, same as
// tasks), which needs `page` added to the `followers.entity_type` Postgres
// enum. `FOLLOWABLE_ENTITY_TYPES` in `collections/Followers.ts` already lists
// it; this is the DB-side half.
//
// Postgres can't drop a single enum value (no `ALTER TYPE ... DROP VALUE`),
// so `down()` can't cleanly reverse this in isolation — it's a no-op with an
// explanatory comment, matching how a genuinely one-directional enum-add
// would be handled elsewhere in this schema.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_followers_entity_type" ADD VALUE IF NOT EXISTS 'page';`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // Intentionally a no-op — see comment above.
  void db
}
