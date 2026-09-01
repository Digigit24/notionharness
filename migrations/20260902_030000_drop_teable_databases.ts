import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/** Removes the retired Teable connection collection after native databases
 * and generic page links became the sole database implementation. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels"
      DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_teable_databases_fk";
    DROP INDEX IF EXISTS "payload_locked_documents_rels_teable_databases_id_idx";
    ALTER TABLE "payload_locked_documents_rels"
      DROP COLUMN IF EXISTS "teable_databases_id";
    DROP TABLE IF EXISTS "teable_databases" CASCADE;
  `)
}

/** Restores the exact post-base-id Teable collection shape and Payload lock
 * relation, allowing a rollback without relying on schema auto-push. */
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "teable_databases" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" varchar NOT NULL,
      "workspace_id" integer NOT NULL,
      "teable_table_id" varchar NOT NULL,
      "teable_base_id" varchar NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "teable_databases"
      ADD CONSTRAINT "teable_databases_workspace_id_workspaces_id_fk"
      FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
      ON DELETE set null ON UPDATE no action;
    CREATE INDEX "teable_databases_workspace_idx" ON "teable_databases" USING btree ("workspace_id");
    CREATE INDEX "teable_databases_updated_at_idx" ON "teable_databases" USING btree ("updated_at");
    CREATE INDEX "teable_databases_created_at_idx" ON "teable_databases" USING btree ("created_at");
    ALTER TABLE "payload_locked_documents_rels"
      ADD COLUMN "teable_databases_id" integer;
    ALTER TABLE "payload_locked_documents_rels"
      ADD CONSTRAINT "payload_locked_documents_rels_teable_databases_fk"
      FOREIGN KEY ("teable_databases_id") REFERENCES "public"."teable_databases"("id")
      ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "payload_locked_documents_rels_teable_databases_id_idx"
      ON "payload_locked_documents_rels" USING btree ("teable_databases_id");
  `)
}
