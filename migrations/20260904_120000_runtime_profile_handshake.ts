import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Runtime handshake capture — what makes a second ACP CLI possible.
//
// Detection now happens in two steps (`lib/runtimes/detect.ts`): does the
// binary exist, and does it complete an ACP `initialize`. The second step
// returns the agent's own description of itself, and these columns store it
// verbatim rather than folding it into booleans we maintain.
//
// Why verbatim: a capability matrix written by us is a set of claims about
// other people's software that goes stale on their release schedule. The
// handshake is the agent's own answer, so it cannot be wrong about itself.
// Verified live against Hermes, which reports `loadSession: true` and offers
// no `availableModels` — the second being genuinely different from "we did
// not ask", which is why capability helpers return a tri-state.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "runtime_profiles" ADD COLUMN IF NOT EXISTS "handshake" jsonb;
    ALTER TABLE "runtime_profiles" ADD COLUMN IF NOT EXISTS "last_probe_code" varchar;
    ALTER TABLE "runtime_profiles" ADD COLUMN IF NOT EXISTS "last_probe_detail" varchar;
    ALTER TABLE "runtime_profiles" ADD COLUMN IF NOT EXISTS "last_probed_at" timestamp(3) with time zone;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "runtime_profiles" DROP COLUMN IF EXISTS "handshake";
    ALTER TABLE "runtime_profiles" DROP COLUMN IF EXISTS "last_probe_code";
    ALTER TABLE "runtime_profiles" DROP COLUMN IF EXISTS "last_probe_detail";
    ALTER TABLE "runtime_profiles" DROP COLUMN IF EXISTS "last_probed_at";
  `)
}
