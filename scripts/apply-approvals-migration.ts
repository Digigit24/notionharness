import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

// One-off apply script for migrations/20260902_090000_approvals.ts — run
// via short-lived pg.Pool, NOT `payload migrate` (which prompts
// interactively about dev-mode drift and hangs non-interactively; see
// AGENTS.md / lib/broker/migrations/apply.ts for the same pattern). Mirrors
// the migration file's up() SQL exactly, then records the row in
// payload_migrations so `payload migrate:status` reports it as applied.
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
  try {
    await pool.query(`
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

    const batchRes = await pool.query<{ max: string | null }>(`SELECT MAX(batch) AS max FROM payload_migrations`)
    const nextBatch = Number(batchRes.rows[0]?.max ?? 0) + 1
    await pool.query(`INSERT INTO payload_migrations (name, batch) VALUES ($1, $2)`, ['20260902_090000_approvals', nextBatch])

    console.log('Approvals schema applied: approvals table, enum, indexes, payload_locked_documents_rels column.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
