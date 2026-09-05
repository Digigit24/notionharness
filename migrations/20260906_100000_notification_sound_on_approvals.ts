import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// A chime when an agent needs a decision.
//
// One additive boolean on `notification_preferences`: whether the open app
// plays a sound when a new approval is waiting for this user. Defaults on,
// like the push toggles and for the same reason — the point of an agent
// working while a person looks elsewhere is that the person is told when
// they are needed, and a sound nobody turned on is a sound nobody hears.
//
// `IF NOT EXISTS` because this database was created by dev-mode push in
// places (see the plugins migration's note), and an additive statement that
// can be re-run is worth more than one that cannot.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "sound_on_approvals" boolean DEFAULT true NOT NULL;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "sound_on_approvals";
  `)
}
