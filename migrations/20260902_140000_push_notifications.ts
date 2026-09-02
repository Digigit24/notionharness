import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// ROADMAP B5.3 (Batch B-5 "Attention") — hand-written migration for the two
// new collections backing real notification delivery:
// `collections/PushSubscriptions.ts` and
// `collections/NotificationPreferences.ts`. Same "written, not applied"
// discipline as every migration in this directory's recent family (Pages.
// project, runs.suggestion_status, SavedViews): prepared for review,
// deliberately NOT run against the live DB. Whole-new-table shape (not an
// additive column on an existing hot-read table), so — like SavedViews and
// unlike Pages.project — both collections *are* already registered in
// payload.config.ts; that's safe because nothing existing queries either
// table yet, so nothing breaks until this migration is applied and the new
// subscribe/preferences code paths are actually exercised. Mirrors
// `migrations/20260902_120000_saved_views.ts`'s shape exactly (new table(s)
// + payload_locked_documents_rels wiring for Payload's admin locking
// feature), just for two tables instead of one.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "push_subscriptions" (
      "id" serial PRIMARY KEY NOT NULL,
      "user_id" integer NOT NULL,
      "endpoint" varchar NOT NULL,
      "p256dh" varchar NOT NULL,
      "auth" varchar NOT NULL,
      "user_agent" varchar,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint");
    CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");

    CREATE TABLE "notification_preferences" (
      "id" serial PRIMARY KEY NOT NULL,
      "user_id" integer NOT NULL,
      "push_approvals" boolean DEFAULT true NOT NULL,
      "push_completions" boolean DEFAULT true NOT NULL,
      "push_mentions" boolean DEFAULT true NOT NULL,
      "email_digest_enabled" boolean DEFAULT false NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_unique" UNIQUE("user_id");
    CREATE INDEX "notification_preferences_user_idx" ON "notification_preferences" USING btree ("user_id");

    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "push_subscriptions_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_push_subscriptions_fk" FOREIGN KEY ("push_subscriptions_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "payload_locked_documents_rels_push_subscriptions_id_idx" ON "payload_locked_documents_rels" USING btree ("push_subscriptions_id");

    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notification_preferences_id" integer;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notification_preferences_fk" FOREIGN KEY ("notification_preferences_id") REFERENCES "public"."notification_preferences"("id") ON DELETE cascade ON UPDATE no action;
    CREATE INDEX "payload_locked_documents_rels_notification_preferences_id_idx" ON "payload_locked_documents_rels" USING btree ("notification_preferences_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_notification_preferences_fk";
    DROP INDEX "payload_locked_documents_rels_notification_preferences_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notification_preferences_id";

    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_push_subscriptions_fk";
    DROP INDEX "payload_locked_documents_rels_push_subscriptions_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "push_subscriptions_id";

    DROP TABLE "notification_preferences" CASCADE;
    DROP TABLE "push_subscriptions" CASCADE;
  `)
}
