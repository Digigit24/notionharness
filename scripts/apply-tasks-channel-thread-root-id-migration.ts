import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

// One-off apply script for
// migrations/20260905_020000_tasks_channel_thread_root_id.ts — run via a
// short-lived pg.Pool, NOT `payload migrate` (which prompts interactively
// about this database's dev-push drift and hangs non-interactively; see
// AGENTS.md / scripts/apply-media-migration.ts for the same pattern). Mirrors
// that migration file's up() SQL exactly, then records the row in
// payload_migrations so `payload migrate:status` reports it as applied.
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
  try {
    await pool.query(`
      ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "channel_thread_root_id" bigint;
      CREATE INDEX IF NOT EXISTS "tasks_channel_thread_root_id_idx" ON "tasks" USING btree ("channel_thread_root_id");
    `)

    const batchRes = await pool.query<{ max: string | null }>(`SELECT MAX(batch) AS max FROM payload_migrations`)
    const nextBatch = Number(batchRes.rows[0]?.max ?? 0) + 1
    await pool.query(`INSERT INTO payload_migrations (name, batch) VALUES ($1, $2)`, [
      '20260905_020000_tasks_channel_thread_root_id',
      nextBatch,
    ])

    console.log('tasks.channel_thread_root_id applied: column + index, payload_migrations recorded.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
