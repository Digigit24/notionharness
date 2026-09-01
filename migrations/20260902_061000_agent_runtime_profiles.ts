import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/** Hand-written migration for the agent configuration registry. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_runtime_profiles_protocol_family" AS ENUM('acp', 'mcp');
    CREATE TYPE "public"."enum_runtimes_status" AS ENUM('up', 'down', 'unknown');
    CREATE TYPE "public"."enum_agents_thinking_level" AS ENUM('low', 'medium', 'high');
    CREATE TYPE "public"."enum_agents_permission_mode" AS ENUM('ask', 'auto', 'deny');
    CREATE TABLE "runtime_profiles" (
      "id" serial PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "workspace_id" integer NOT NULL,
      "protocol_family" "enum_runtime_profiles_protocol_family" NOT NULL, "command_name" varchar NOT NULL,
      "fixed_args" jsonb DEFAULT '[]'::jsonb, "enabled" boolean DEFAULT true,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "runtimes" (
      "id" serial PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "workspace_id" integer NOT NULL,
      "runtime_profile_id" integer NOT NULL, "host" varchar NOT NULL, "connection_info" jsonb DEFAULT '{}'::jsonb,
      "status" "enum_runtimes_status" DEFAULT 'unknown' NOT NULL, "last_checked_at" timestamp(3) with time zone,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "agents" (
      "id" serial PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "workspace_id" integer NOT NULL,
      "runtime_profile_id" integer NOT NULL, "model" varchar, "thinking_level" "enum_agents_thinking_level" DEFAULT 'medium',
      "instructions" varchar, "custom_env" jsonb DEFAULT '{}'::jsonb, "custom_args" jsonb DEFAULT '[]'::jsonb,
      "mcp_config" jsonb DEFAULT '{}'::jsonb, "skills" jsonb DEFAULT '[]'::jsonb, "max_concurrent_runs" numeric DEFAULT 1,
      "permission_mode" "enum_agents_permission_mode" DEFAULT 'ask' NOT NULL, "enabled" boolean DEFAULT true,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE restrict ON UPDATE no action;
    CREATE INDEX "runtime_profiles_workspace_idx" ON "runtime_profiles" USING btree ("workspace_id");
    CREATE INDEX "runtimes_workspace_idx" ON "runtimes" USING btree ("workspace_id");
    CREATE INDEX "runtimes_runtime_profile_idx" ON "runtimes" USING btree ("runtime_profile_id");
    CREATE INDEX "agents_workspace_idx" ON "agents" USING btree ("workspace_id");
    CREATE INDEX "agents_runtime_profile_idx" ON "agents" USING btree ("runtime_profile_id");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "runtime_profiles_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "runtimes_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "agents_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_runtime_profiles_fk" FOREIGN KEY ("runtime_profiles_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_runtimes_fk" FOREIGN KEY ("runtimes_id") REFERENCES "public"."runtimes"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_agents_fk" FOREIGN KEY ("agents_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "payload_locked_documents_rels_runtime_profiles_id_idx" ON "payload_locked_documents_rels" USING btree ("runtime_profiles_id");
    CREATE INDEX "payload_locked_documents_rels_runtimes_id_idx" ON "payload_locked_documents_rels" USING btree ("runtimes_id");
    CREATE INDEX "payload_locked_documents_rels_agents_id_idx" ON "payload_locked_documents_rels" USING btree ("agents_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_runtime_profiles_fk";
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_runtimes_fk";
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_agents_fk";
    DROP INDEX "payload_locked_documents_rels_runtime_profiles_id_idx";
    DROP INDEX "payload_locked_documents_rels_runtimes_id_idx";
    DROP INDEX "payload_locked_documents_rels_agents_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "runtime_profiles_id";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "runtimes_id";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "agents_id";
    DROP TABLE "agents" CASCADE;
    DROP TABLE "runtimes" CASCADE;
    DROP TABLE "runtime_profiles" CASCADE;
    DROP TYPE "public"."enum_agents_permission_mode";
    DROP TYPE "public"."enum_agents_thinking_level";
    DROP TYPE "public"."enum_runtimes_status";
    DROP TYPE "public"."enum_runtime_profiles_protocol_family";
  `)
}
