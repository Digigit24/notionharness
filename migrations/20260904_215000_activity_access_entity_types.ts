import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Audit entity types for the things access control and connectors act on.
//
// `activity` is the audit log, and its whole value is that you can ask it "what
// happened to THIS thing". That only works if the thing has an entity type of
// its own. Before this, `ACTIVITY_ENTITY_TYPES` was `task|project|page|run`
// plus `workspace`, so a grant on an agent, a grant on a channel, or a
// connector being added had nowhere honest to be filed — the available choices
// were to anchor them all to the workspace, which makes a per-agent or
// per-connector timeline impossible to reconstruct, or to anchor them to
// `project`, which is wrong for two of the three connector scopes and leaves
// half the events unfilterable.
//
// So: three values, added together in ONE migration on purpose. Two agents
// independently wrote competing migrations for two of these at the same
// timestamp, both editing the same enum and the same index file — which is the
// signal that this belongs to whoever owns the audit log rather than to
// whichever feature needed it first.
//
// `ADD VALUE IF NOT EXISTS` is idempotent, and each statement runs separately
// because Postgres refuses `ALTER TYPE ... ADD VALUE` inside a transaction
// block on the versions this app supports.
const VALUES = ['agent', 'channel', 'connector'] as const

export async function up({ db }: MigrateUpArgs): Promise<void> {
  for (const value of VALUES) {
    await db.execute(sql.raw(`ALTER TYPE "enum_activity_entity_type" ADD VALUE IF NOT EXISTS '${value}';`))
  }
}

export async function down(_args: MigrateDownArgs): Promise<void> {
  // Postgres cannot remove a value from an enum without rewriting the type and
  // every column using it. Down is a deliberate no-op: the cost of reversing
  // this vastly exceeds the cost of an unused enum value, and a `down` that
  // silently did something else would be worse than one that does nothing.
}
