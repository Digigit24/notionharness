import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Per-agent Hermes profile — the column that makes a different model per
// agent actually possible.
//
// Background, because AGENTS.md currently says the opposite: that file states
// "Per-agent model selection is not currently possible ... Hermes has exactly
// one active model/provider for the whole install." The first half of its
// evidence is right — `hermes-acp --help` genuinely has no `--model` or
// `--provider` flag, verified again here. The conclusion is wrong, and its
// own parenthetical ("or per-profile, if using separate Hermes profiles")
// already contained the answer.
//
// A Hermes *profile* directory IS a complete HERMES_HOME: verified on this
// machine, `<hermes>/profiles/ritik` carries its own `config.yaml`,
// `auth.json`, `SOUL.md`, `skills/`, `memories/` and `state.db`, and its
// `model:` block pins `gpt-5.6-terra` while the install root pins
// `gpt-5.4-mini`. So model selection per agent needs no CLI flag at all —
// only a different HERMES_HOME.
//
// Which is why this is a plain text column and not a relationship: the
// authority for what profiles exist is the Hermes install on disk, not this
// database. Storing a foreign key would mean mirroring (and inevitably
// desynchronising) state that another program owns. A name is a reference we
// re-resolve at spawn time, and a profile deleted in Hermes surfaces as a
// clear "profile not found" rather than a dangling row.
//
// Deliberately nullable with no default: NULL means "use the install root",
// which is exactly today's behaviour, so this migration cannot change how any
// existing agent runs.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "hermes_profile" varchar;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "agents" DROP COLUMN IF EXISTS "hermes_profile";
  `)
}
