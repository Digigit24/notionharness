import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// A machine, named — the piece host-scoped claiming
// (20260906_120000_runtime_profiles_host_id) left implicit. That migration's
// `runtime_profiles.host_id` is what the dispatcher actually reads; this
// table exists only so "add a machine" is one visible action with a name a
// person chose, instead of something that happens silently the first time a
// runtime profile is created from a new hostname.
//
// `(workspace_id, host_key)` is uniquely indexed, not `host_key` alone: two
// different workspaces on this same install must be free to both have a
// machine whose raw identity is the same hostname.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "runtime_hosts" (
      "id" serial PRIMARY KEY NOT NULL,
      "workspace_id" integer NOT NULL,
      "display_name" varchar NOT NULL,
      "host_key" varchar NOT NULL,
      "added_by_id" integer,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );

    ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

    CREATE INDEX "runtime_hosts_workspace_idx" ON "runtime_hosts" USING btree ("workspace_id");
    CREATE UNIQUE INDEX "runtime_hosts_workspace_host_key_uidx" ON "runtime_hosts" USING btree ("workspace_id", "host_key");
    CREATE INDEX "runtime_hosts_updated_at_idx" ON "runtime_hosts" USING btree ("updated_at");
    CREATE INDEX "runtime_hosts_created_at_idx" ON "runtime_hosts" USING btree ("created_at");

    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "runtime_hosts_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_runtime_hosts_fk" FOREIGN KEY ("runtime_hosts_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "payload_locked_documents_rels_runtime_hosts_id_idx" ON "payload_locked_documents_rels" USING btree ("runtime_hosts_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_runtime_hosts_fk";
    DROP INDEX "payload_locked_documents_rels_runtime_hosts_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "runtime_hosts_id";
    DROP TABLE "runtime_hosts" CASCADE;
  `)
}
