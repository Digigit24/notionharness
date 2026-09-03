import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Phase C, C1.6/§02 — new `project_resources` collection (see collections/
// ProjectResources.ts's own comment for the full rationale). Written,
// NOT applied, and the collection is deliberately NOT yet added to
// payload.config.ts's `collections` array — same discipline as every other
// schema-gated item this session (see AGENTS.md's Phase C notes and
// migrations/20260903_130000_hermes_config.ts's identical comment):
// `push: false` means registering a collection before its table exists
// would break the very next request that touches it, for whoever is
// actually running this app live. A human must run this migration AND add
// the collection to payload.config.ts together.
//
// The one constraint this schema exists to guarantee that app code alone
// can't: **exactly one `primary` resource per project.** A partial unique
// index (`WHERE "role" = 'primary'`) enforces it at the database, not just
// in a server action — "where does the agent start?" must never be
// ambiguous, and a DB constraint can't be bypassed by a bug in a future
// caller the way an app-level check could be.
//
// `payload_locked_documents_rels` wiring follows the exact pattern
// `migrations/20260902_090000_approvals.ts` already established for a new
// collection (confirmed via `node_modules/payload/dist/locked-documents/
// config.js`: collections need this FK-based polymorphic-relation wiring
// for Payload's admin document-locking feature; Globals do NOT — a Global
// lock is tracked by a plain `globalSlug` text column that already exists
// generically, which is why `hermes_config`'s own migration doesn't have
// this same block).
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_project_resources_kind" AS ENUM('git_repo', 'local_dir');
    CREATE TYPE "public"."enum_project_resources_role" AS ENUM('primary', 'reference', 'output', 'scratch');
    CREATE TABLE "project_resources" (
      "id" serial PRIMARY KEY NOT NULL,
      "project_id" integer NOT NULL,
      "kind" "enum_project_resources_kind" NOT NULL,
      "path" varchar,
      "repo_url" varchar,
      "default_branch" varchar,
      "role" "enum_project_resources_role" NOT NULL,
      "writable" boolean DEFAULT true,
      "position" numeric,
      "last_verified_at" timestamp(3) with time zone,
      "exists" boolean,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "project_resources" ADD CONSTRAINT "project_resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "project_resources_project_idx" ON "project_resources" USING btree ("project_id");
    CREATE UNIQUE INDEX "project_resources_one_primary_per_project_idx" ON "project_resources" USING btree ("project_id") WHERE "role" = 'primary';
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "project_resources_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_project_resources_fk" FOREIGN KEY ("project_resources_id") REFERENCES "public"."project_resources"("id") ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "payload_locked_documents_rels_project_resources_id_idx" ON "payload_locked_documents_rels" USING btree ("project_resources_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_project_resources_fk";
    DROP INDEX "payload_locked_documents_rels_project_resources_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "project_resources_id";
    DROP TABLE "project_resources" CASCADE;
    DROP TYPE "public"."enum_project_resources_kind";
    DROP TYPE "public"."enum_project_resources_role";
  `)
}
