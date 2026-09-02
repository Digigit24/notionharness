import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/** Hand-written migration for P5.4's first-class Approval objects (roadmap/approvals). */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_approvals_status" AS ENUM('pending', 'approved', 'denied', 'timeout');
    CREATE TABLE "approvals" (
      "id" serial PRIMARY KEY NOT NULL, "run_id" integer, "external_id" varchar NOT NULL,
      "requested_user_id" integer NOT NULL, "title" varchar NOT NULL, "detail" varchar,
      "options" jsonb DEFAULT '[]'::jsonb NOT NULL, "status" "enum_approvals_status" DEFAULT 'pending' NOT NULL,
      "selected_option_id" varchar,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "approvals" ADD CONSTRAINT "approvals_external_id_unique" UNIQUE("external_id");
    ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_user_id_users_id_fk" FOREIGN KEY ("requested_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX "approvals_requested_user_idx" ON "approvals" USING btree ("requested_user_id");
    CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "approvals_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_approvals_fk" FOREIGN KEY ("approvals_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "payload_locked_documents_rels_approvals_id_idx" ON "payload_locked_documents_rels" USING btree ("approvals_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_approvals_fk";
    DROP INDEX "payload_locked_documents_rels_approvals_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "approvals_id";
    DROP TABLE "approvals" CASCADE;
    DROP TYPE "public"."enum_approvals_status";
  `)
}
