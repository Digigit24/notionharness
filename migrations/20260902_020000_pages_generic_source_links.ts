import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// NOTION-PARITY 2 — generalizes `pages`' row-linking columns beyond Teable.
// `linked_teable_table_id`/`linked_teable_record_id` (added by
// `20260901_120000_pages_teable_links.ts`) become `linked_source_id`/
// `linked_record_id` (renamed, same varchar columns, same data) plus a new
// `linked_source_type` enum column identifying which DataSource backend
// (`UserDatabaseDataSource` or `PayloadDataSource` — no `'teable'` variant,
// since Teable is being dropped entirely per the roadmap's pivot; a
// currently-Teable-linked page simply has no source type once this runs).
//
// Hand-written, not `payload migrate:create`: same pre-existing Drizzle
// snapshot drift documented in `20260902_000000_user_databases.ts` makes the
// interactive generator hang. Matches that migration's plain-SQL style.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_pages_linked_source_type" AS ENUM('userDatabase', 'payload');

   DROP INDEX IF EXISTS "pages_linked_teable_table_id_idx";
   DROP INDEX IF EXISTS "pages_linked_teable_record_id_idx";

   ALTER TABLE "pages" RENAME COLUMN "linked_teable_table_id" TO "linked_source_id";
   ALTER TABLE "pages" RENAME COLUMN "linked_teable_record_id" TO "linked_record_id";

   ALTER TABLE "pages" ADD COLUMN "linked_source_type" "enum_pages_linked_source_type";

   CREATE INDEX "pages_linked_source_id_idx" ON "pages" USING btree ("linked_source_id");
   CREATE INDEX "pages_linked_record_id_idx" ON "pages" USING btree ("linked_record_id");
   CREATE INDEX "pages_linked_source_type_idx" ON "pages" USING btree ("linked_source_type");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX IF EXISTS "pages_linked_source_type_idx";
   DROP INDEX IF EXISTS "pages_linked_record_id_idx";
   DROP INDEX IF EXISTS "pages_linked_source_id_idx";

   ALTER TABLE "pages" DROP COLUMN "linked_source_type";

   ALTER TABLE "pages" RENAME COLUMN "linked_record_id" TO "linked_teable_record_id";
   ALTER TABLE "pages" RENAME COLUMN "linked_source_id" TO "linked_teable_table_id";

   DROP TYPE "public"."enum_pages_linked_source_type";

   CREATE INDEX "pages_linked_teable_table_id_idx" ON "pages" USING btree ("linked_teable_table_id");
   CREATE INDEX "pages_linked_teable_record_id_idx" ON "pages" USING btree ("linked_teable_record_id");`)
}
