import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// `teable-databases` is no longer used for iframe embedding (see
// `collections/TeableDatabases.ts`) — Teable's REST API needs a base id
// alongside the table id, which nothing captured until now.
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "teable_databases" DROP COLUMN "embedded_view_url";
  ALTER TABLE "teable_databases" ADD COLUMN "teable_base_id" varchar NOT NULL DEFAULT '';
  ALTER TABLE "teable_databases" ALTER COLUMN "teable_base_id" DROP DEFAULT;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "teable_databases" DROP COLUMN "teable_base_id";
  ALTER TABLE "teable_databases" ADD COLUMN "embedded_view_url" varchar;`)
}
