import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// ROADMAP P2.1/2.2 — the workspace-core system tables: projects, tasks,
// task_statuses (with the fixed 7-category vocabulary per D-level decision),
// task_links, followers, comments, activity (one polymorphic table per
// roadmap 2.6), notifications, artifacts — plus workspaces.task_prefix/
// task_counter for later human-readable task IDs.
//
// Hand-written, not `payload migrate:create`: same pre-existing Drizzle
// snapshot drift documented in AGENTS.md/prior migrations makes the
// interactive generator hang. Matches the exact column/constraint/index
// conventions of `20260902_000000_user_databases.ts` and the initial
// migration — including the one genuinely odd-looking but consistent
// pattern already established throughout this schema: a `required: true`
// Payload relationship still gets `ON DELETE set null` at the DB level
// (e.g. `pages.workspace_id NOT NULL` + `ON DELETE set null`), never
// `cascade`, for every *single* relationship column. Only `payload_locked_
// documents_rels`-style join tables use `cascade`.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_task_statuses_category" AS ENUM('backlog', 'todo', 'inProgress', 'inReview', 'done', 'blocked', 'cancelled');
   CREATE TYPE "public"."enum_task_links_link_type" AS ENUM('blocks', 'relatesTo', 'parentOf');
   CREATE TYPE "public"."enum_followers_entity_type" AS ENUM('task', 'project');
   CREATE TYPE "public"."enum_activity_entity_type" AS ENUM('task', 'project', 'page', 'run');

   ALTER TABLE "workspaces" ADD COLUMN "task_prefix" varchar;
   ALTER TABLE "workspaces" ADD COLUMN "task_counter" numeric DEFAULT 0;

   CREATE TABLE "projects" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"name" varchar DEFAULT 'Untitled' NOT NULL,
   	"workspace_id" integer NOT NULL,
   	"icon" varchar,
   	"description" varchar,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "task_statuses" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"workspace_id" integer NOT NULL,
   	"name" varchar NOT NULL,
   	"category" "enum_task_statuses_category" NOT NULL,
   	"color" varchar,
   	"position" numeric DEFAULT 0,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "tasks" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"title" varchar DEFAULT 'Untitled' NOT NULL,
   	"workspace_id" integer NOT NULL,
   	"project_id" integer,
   	"status_id" integer NOT NULL,
   	"assignee_id" integer,
   	"created_by_id" integer NOT NULL,
   	"position" numeric DEFAULT 0,
   	"revision" bigint DEFAULT 0 NOT NULL,
   	"last_activity_at" timestamp(3) with time zone,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "task_links" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"from_task_id" integer NOT NULL,
   	"to_task_id" integer NOT NULL,
   	"link_type" "enum_task_links_link_type" NOT NULL,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "followers" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"user_id" integer NOT NULL,
   	"entity_type" "enum_followers_entity_type" NOT NULL,
   	"entity_id" varchar NOT NULL,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "comments" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"task_id" integer NOT NULL,
   	"author_id" integer NOT NULL,
   	"body" varchar NOT NULL,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "activity" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"entity_type" "enum_activity_entity_type" NOT NULL,
   	"entity_id" varchar NOT NULL,
   	"actor_id" integer,
   	"action" varchar NOT NULL,
   	"payload" jsonb DEFAULT '{}'::jsonb,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "notifications" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"user_id" integer NOT NULL,
   	"activity_id" integer,
   	"message" varchar,
   	"is_read" boolean DEFAULT false,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   CREATE TABLE "artifacts" (
   	"id" serial PRIMARY KEY NOT NULL,
   	"task_id" integer NOT NULL,
   	"name" varchar NOT NULL,
   	"url" varchar NOT NULL,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
   	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );

   ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "task_statuses" ADD CONSTRAINT "task_statuses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_id_task_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."task_statuses"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "task_links" ADD CONSTRAINT "task_links_from_task_id_tasks_id_fk" FOREIGN KEY ("from_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "task_links" ADD CONSTRAINT "task_links_to_task_id_tasks_id_fk" FOREIGN KEY ("to_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "followers" ADD CONSTRAINT "followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "notifications" ADD CONSTRAINT "notifications_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE set null ON UPDATE no action;
   ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;

   CREATE INDEX "projects_workspace_idx" ON "projects" USING btree ("workspace_id");
   CREATE INDEX "projects_updated_at_idx" ON "projects" USING btree ("updated_at");
   CREATE INDEX "projects_created_at_idx" ON "projects" USING btree ("created_at");

   CREATE INDEX "task_statuses_workspace_idx" ON "task_statuses" USING btree ("workspace_id");
   CREATE INDEX "task_statuses_updated_at_idx" ON "task_statuses" USING btree ("updated_at");
   CREATE INDEX "task_statuses_created_at_idx" ON "task_statuses" USING btree ("created_at");

   CREATE INDEX "tasks_workspace_idx" ON "tasks" USING btree ("workspace_id");
   CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");
   CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status_id");
   CREATE INDEX "tasks_updated_at_idx" ON "tasks" USING btree ("updated_at");
   CREATE INDEX "tasks_created_at_idx" ON "tasks" USING btree ("created_at");

   CREATE INDEX "task_links_from_task_idx" ON "task_links" USING btree ("from_task_id");
   CREATE INDEX "task_links_to_task_idx" ON "task_links" USING btree ("to_task_id");
   CREATE INDEX "task_links_updated_at_idx" ON "task_links" USING btree ("updated_at");
   CREATE INDEX "task_links_created_at_idx" ON "task_links" USING btree ("created_at");

   CREATE INDEX "followers_user_idx" ON "followers" USING btree ("user_id");
   CREATE INDEX "followers_entity_id_idx" ON "followers" USING btree ("entity_id");
   CREATE INDEX "followers_updated_at_idx" ON "followers" USING btree ("updated_at");
   CREATE INDEX "followers_created_at_idx" ON "followers" USING btree ("created_at");

   CREATE INDEX "comments_task_idx" ON "comments" USING btree ("task_id");
   CREATE INDEX "comments_updated_at_idx" ON "comments" USING btree ("updated_at");
   CREATE INDEX "comments_created_at_idx" ON "comments" USING btree ("created_at");

   CREATE INDEX "activity_entity_type_idx" ON "activity" USING btree ("entity_type");
   CREATE INDEX "activity_entity_id_idx" ON "activity" USING btree ("entity_id");
   CREATE INDEX "activity_updated_at_idx" ON "activity" USING btree ("updated_at");
   CREATE INDEX "activity_created_at_idx" ON "activity" USING btree ("created_at");

   CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");
   CREATE INDEX "notifications_is_read_idx" ON "notifications" USING btree ("is_read");
   CREATE INDEX "notifications_updated_at_idx" ON "notifications" USING btree ("updated_at");
   CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");

   CREATE INDEX "artifacts_task_idx" ON "artifacts" USING btree ("task_id");
   CREATE INDEX "artifacts_updated_at_idx" ON "artifacts" USING btree ("updated_at");
   CREATE INDEX "artifacts_created_at_idx" ON "artifacts" USING btree ("created_at");

   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "projects_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "task_statuses_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "tasks_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "task_links_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "followers_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "comments_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "activity_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notifications_id" integer;
   ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "artifacts_id" integer;

   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_projects_fk" FOREIGN KEY ("projects_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_task_statuses_fk" FOREIGN KEY ("task_statuses_id") REFERENCES "public"."task_statuses"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_tasks_fk" FOREIGN KEY ("tasks_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_task_links_fk" FOREIGN KEY ("task_links_id") REFERENCES "public"."task_links"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_followers_fk" FOREIGN KEY ("followers_id") REFERENCES "public"."followers"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_comments_fk" FOREIGN KEY ("comments_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_activity_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notifications_fk" FOREIGN KEY ("notifications_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_artifacts_fk" FOREIGN KEY ("artifacts_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;

   CREATE INDEX "payload_locked_documents_rels_projects_id_idx" ON "payload_locked_documents_rels" USING btree ("projects_id");
   CREATE INDEX "payload_locked_documents_rels_task_statuses_id_idx" ON "payload_locked_documents_rels" USING btree ("task_statuses_id");
   CREATE INDEX "payload_locked_documents_rels_tasks_id_idx" ON "payload_locked_documents_rels" USING btree ("tasks_id");
   CREATE INDEX "payload_locked_documents_rels_task_links_id_idx" ON "payload_locked_documents_rels" USING btree ("task_links_id");
   CREATE INDEX "payload_locked_documents_rels_followers_id_idx" ON "payload_locked_documents_rels" USING btree ("followers_id");
   CREATE INDEX "payload_locked_documents_rels_comments_id_idx" ON "payload_locked_documents_rels" USING btree ("comments_id");
   CREATE INDEX "payload_locked_documents_rels_activity_id_idx" ON "payload_locked_documents_rels" USING btree ("activity_id");
   CREATE INDEX "payload_locked_documents_rels_notifications_id_idx" ON "payload_locked_documents_rels" USING btree ("notifications_id");
   CREATE INDEX "payload_locked_documents_rels_artifacts_id_idx" ON "payload_locked_documents_rels" USING btree ("artifacts_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_projects_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_task_statuses_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_tasks_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_task_links_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_followers_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_comments_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_activity_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_notifications_fk";
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_artifacts_fk";

   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "projects_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "task_statuses_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "tasks_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "task_links_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "followers_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "comments_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "activity_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notifications_id";
   ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "artifacts_id";

   DROP TABLE "artifacts" CASCADE;
   DROP TABLE "notifications" CASCADE;
   DROP TABLE "activity" CASCADE;
   DROP TABLE "comments" CASCADE;
   DROP TABLE "followers" CASCADE;
   DROP TABLE "task_links" CASCADE;
   DROP TABLE "tasks" CASCADE;
   DROP TABLE "task_statuses" CASCADE;
   DROP TABLE "projects" CASCADE;

   ALTER TABLE "workspaces" DROP COLUMN "task_counter";
   ALTER TABLE "workspaces" DROP COLUMN "task_prefix";

   DROP TYPE "public"."enum_activity_entity_type";
   DROP TYPE "public"."enum_followers_entity_type";
   DROP TYPE "public"."enum_task_links_link_type";
   DROP TYPE "public"."enum_task_statuses_category";`)
}
