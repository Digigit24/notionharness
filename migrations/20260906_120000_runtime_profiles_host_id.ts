import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Host-scoped runtime claiming — closes the multi-machine gap.
//
// A profile has always named a binary on THE machine that created it
// (collections/RuntimeProfiles.ts's own header comment), but the dispatcher's
// claim query (`lib/broker/runs.ts`'s `claimNextRun`) never knew that: any
// machine's dispatcher loop could claim any queued run, including one whose
// agent's runtime profile only exists on a DIFFERENT machine. That claim then
// fails to spawn (ENOENT) and — because `runtime_not_installed` was
// unconditionally non-retryable — the run died permanently instead of being
// left for the right machine to pick up.
//
// `host_id` is NULL by default, which the claim query reads as "any host may
// claim this" — every profile that exists before this migration keeps working
// exactly as it did on a single machine. A NEW profile defaults to the
// creating machine's own id (`lib/runtimes/host-id.ts`), so the multi-machine
// case (each machine adds its own runtimes from its own Runtimes page) is
// correctly scoped with zero extra configuration.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "runtime_profiles" ADD COLUMN IF NOT EXISTS "host_id" varchar;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "runtime_profiles" DROP COLUMN IF EXISTS "host_id";
  `)
}
