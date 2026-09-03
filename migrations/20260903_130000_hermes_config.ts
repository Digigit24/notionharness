import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Phase C, C1.1 — "Hermes connection settings... stored in the DB (not
// env), with a Test connection button." This is the backing table for that:
// a Payload Global (see globals/HermesConfig.ts — NOT yet added to
// payload.config.ts's `globals` array), used as a strict singleton (the
// application always reads/writes the one row with the lowest id; Payload
// globals don't have a natural multi-row shape, so there's no `id` column
// choice to make here the way a collection would need one).
//
// Deliberately NOT paired with registering the Global in this same change
// — same discipline as `migrations/20260902_150000_spend_caps.ts` (see that
// file's own comment): `payload.config.ts` has `push: false` specifically
// so schema and DB never drift, and this app's own dev/start server is
// frequently left running live (confirmed this session — see AGENTS.md's
// Phase C notes) with no migration gate in front of it. Registering the
// Global before this migration actually runs would make the very next
// request touching Hermes config query a table that doesn't exist. A human
// must run this migration AND add the Global to payload.config.ts together,
// not as two separate steps.
//
// `apiKey` is stored as plain text, matching this codebase's existing
// precedent for secrets-at-rest (e.g. Teable's keys live directly in `.env`,
// and nothing in this repo currently encrypts a stored credential) — not
// declared secure by that precedent, just consistent with it; encryption-at-
// rest for this field is a real, separate gap, not silently assumed solved.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "hermes_config" (
      "id" serial PRIMARY KEY NOT NULL,
      "base_url" varchar,
      "api_key" varchar,
      "verified" boolean DEFAULT false,
      "last_verified_at" timestamp(3) with time zone,
      "last_error" varchar,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE "hermes_config";
  `)
}
