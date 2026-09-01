import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// ROADMAP P2.3/D4 — `databases` + `database_rows`: the generic, user-owned
// tables an `affine:database` block is allowed to hold queryable data in
// (see `collections/Databases.ts`/`collections/DatabaseRows.ts` for why the
// schema itself lives as a `jsonb` array rather than a real column per
// property, unlike a Payload collection's fixed, code-defined fields).
//
// Hand-written (not `payload migrate:create`): the live DB already has the
// later `teable_base_id`/`pages` migrations applied, but this repo's Drizzle
// snapshot JSON files were never regenerated to match those two hand-written
// migrations, so `migrate:create`'s schema diff sees stale drift on an
// unrelated column and prompts interactively — the exact "can hang/prompt"
// risk this project's own house rules warn about. Matches the column/index/
// FK conventions from `20260831_181832_initial.ts` exactly instead.
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "databases" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"name" varchar DEFAULT 'Untitled' NOT NULL,
   	"workspace_id" integer NOT NULL,
   	"fields" jsonb DEFAULT '[]'::jsonb,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "database_rows" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"database_id" integer NOT NULL,
   	"cells" jsonb DEFAULT '{}'::jsonb,
   	"position" numeric DEFAULT 0,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   ALTER TABLE "databases" ADD CONSTRAINT "databases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE set null ON UPDATE no action;

   CREATE INDEX "databases_workspace_idx" ON "databases" USING btree ("workspace_id");
   CREATE INDEX "databases_updated_at_idx" ON "databases" USING btree ("updated_at");
   CREATE INDEX "databases_created_at_idx" ON "databases" USING btree ("created_at");
   CREATE INDEX "database_rows_database_idx" ON "database_rows" USING btree ("database_id");
   CREATE INDEX "database_rows_updated_at_idx" ON "database_rows" USING btree ("updated_at");
   CREATE INDEX "database_rows_created_at_idx" ON "database_rows" USING btree ("created_at");

   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "databases_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "database_rows_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_databases_fk" FOREIGN KEY ("databases_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_database_rows_fk" FOREIGN KEY ("database_rows_id") REFERENCES "public"."database_rows"("id") ON DELETE cascade ON UPDATE no action;
   CREATE INDEX "payload_locked_documents_rels_databases_id_idx" ON "payload_locked_documents_rels" USING btree ("databases_id");
   CREATE INDEX "payload_locked_documents_rels_database_rows_id_idx" ON "payload_locked_documents_rels" USING btree ("database_rows_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_databases_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_database_rows_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "databases_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "database_rows_id";
   DROP TABLE "database_rows" CASCADE;
   DROP TABLE "databases" CASCADE;`)
}
