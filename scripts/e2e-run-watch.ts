// Watch run 61 + any approvals tied to it.
import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 2 })
  try {
    const r = (await pool.query(
      `SELECT id, status, attempt, started_at, lease_expires_at, completed_at, error, updated_at
       FROM runs WHERE id::int=61`
    )).rows[0]
    console.log(`run(61): ${JSON.stringify(r)}`)

    const aps = (await pool.query(
      `SELECT id, external_id, run_id::text AS run_id, status, title, requested_user_id, options, created_at, updated_at
       FROM approvals WHERE run_id::int=61 ORDER BY id ASC`
    )).rows
    console.log(`approvals for run(61): ${aps.length}`)
    aps.forEach(a => console.log(`  ${JSON.stringify({ id: a.id, ext: a.external_id, status: a.status, title: a.title, reqUser: a.requested_user_id, created: a.created_at })}`))

    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='run_messages'
       ORDER BY ordinal_position`
    )).rows.map(c => c.column_name).join(',')
    console.log(`run_messages.columns: ${cols}`)

    const rm = (await pool.query(
      `SELECT * FROM run_messages WHERE run_id::int=61 ORDER BY id ASC LIMIT 30`
    )).rows
    console.log(`run_messages for run(61): ${rm.length} rows`)
    rm.forEach(m => {
      const summary: any = {}
      Object.entries(m).forEach(([k, v]: [string, any]) => {
        if (['payload', 'body', 'data', 'content'].includes(k)) {
          const s = typeof v === 'string' ? v : JSON.stringify(v)
          summary[k] = s.slice(0, 220) + (s.length > 220 ? '...' : '')
        } else { summary[k] = v }
      })
      console.log(`  ${JSON.stringify(summary)}`)
    })
  } finally {
    await pool.end()
  }
}
main().catch(e => { console.error(e); process.exit(1) })
