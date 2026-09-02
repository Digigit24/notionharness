// state check after the killed first attempt
import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 2 })
  try {
    const agent = (await pool.query(`SELECT id, name, permission_mode FROM agents WHERE id=2`)).rows[0]
    console.log(`agent(2): ${JSON.stringify(agent)}`)

    const runs = (await pool.query(
      `SELECT id, status, attempt, error, prompt, updated_at FROM runs ORDER BY updated_at DESC LIMIT 5`
    )).rows
    console.log(`runs:`)
    runs.forEach(r => console.log(`  ${JSON.stringify(r)}`))

    const approvals = (await pool.query(
      `SELECT id, external_id, run_id::text AS run_id, status, title, requested_user_id, created_at FROM approvals ORDER BY id DESC LIMIT 5`
    )).rows
    console.log(`approvals:`)
    approvals.forEach(r => console.log(`  ${JSON.stringify(r)}`))

    // Cleanup any leftover rows from prior aborted attempts
    const del = await pool.query(
      `DELETE FROM approvals WHERE external_id LIKE 'e2e-%' RETURNING id`
    )
    console.log(`cleanup deleted ${del.rowCount} approvals rows`)
  } finally {
    await pool.end()
  }
}
main().catch(e => { console.error(e); process.exit(1) })
