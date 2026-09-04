import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// R12-P4.1 — a runtime gets defaults of its own.
//
// Until now the only place a session setting could live was `agents.
// runtime_config`, so "which model does Claude Code use here" had to be
// answered once per agent. Ten agents meant setting it ten times, and a new
// agent silently inherited whatever the CLI's own default happened to be
// rather than what this workspace had chosen everywhere else.
//
// The column holds the same shape `agents.runtime_config` does — a flat
// `{ [configId]: value }` map of the options the runtime declared about
// itself during the ACP handshake — because the dispatcher merges the two and
// a second shape would mean a translation step between them. Precedence is
// runtime default, then agent, then the per-turn override, with the later one
// winning: choosing high effort for one message must not silently drop the
// model that agent is configured to use.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "runtime_profiles" ADD COLUMN IF NOT EXISTS "default_session_config" jsonb DEFAULT '{}'::jsonb;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "runtime_profiles" DROP COLUMN IF EXISTS "default_session_config";
  `)
}
