import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// ROADMAP B-4 "Work" — hand-written migration for the new `saved-views`
// collection (collections/SavedViews.ts). Same "written, not applied"
// discipline as every other migration in this batch's family (Pages.project,
// runs.suggestion_status): prepared for review, deliberately NOT run against
// the live DB. Whole-new-table shape (not an additive column on an existing
// hot-read table), so — unlike the Pages.project precedent — the collection
// *is* already registered in payload.config.ts; that's safe here because no
// existing code queries `saved-views` yet, so nothing breaks until this
// migration is applied and the new saved-view actions are actually exercised
// (matches this batch's brief, which explicitly asked for the collection
// file + registration as the "written" step for a Payload collection).
// Mirrors `migrations/20260902_090000_approvals.ts`'s shape exactly (new
// enum + table + payload_locked_documents_rels wiring for Payload's admin
// locking feature).
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_saved_views_scope" AS ENUM('workspace', 'project', 'mine');
    CREATE TABLE "saved_views" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" varchar NOT NULL,
      "scope" "enum_saved_views_scope" DEFAULT 'workspace' NOT NULL,
      "workspace_id" integer NOT NULL,
      "project_id" integer,
      "owner_id" integer,
      "created_by_id" integer NOT NULL,
      "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX "saved_views_scope_idx" ON "saved_views" USING btree ("scope");
    CREATE INDEX "saved_views_workspace_idx" ON "saved_views" USING btree ("workspace_id");
    CREATE INDEX "saved_views_project_idx" ON "saved_views" USING btree ("project_id");
    CREATE INDEX "saved_views_owner_idx" ON "saved_views" USING btree ("owner_id");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "saved_views_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_saved_views_fk" FOREIGN KEY ("saved_views_id") REFERENCES "public"."saved_views"("id") ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "payload_locked_documents_rels_saved_views_id_idx" ON "payload_locked_documents_rels" USING btree ("saved_views_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_saved_views_fk";
    DROP INDEX "payload_locked_documents_rels_saved_views_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "saved_views_id";
    DROP TABLE "saved_views" CASCADE;
    DROP TYPE "public"."enum_saved_views_scope";
  `)
}
