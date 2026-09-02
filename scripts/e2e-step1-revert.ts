// Reverse anything I (or any prior in-flight script) might have left in the
// shared fixtures: make sure agent 2's permission_mode is back to 'auto',
// and that no stray approvals rows from earlier exploratory runs linger.
import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 2 })
  try {
    const before = (await pool.query(
      `SELECT id, name, permission_mode FROM agents WHERE id=2`
    )).rows[0]
    console.log(`agent 2 BEFORE: ${JSON.stringify(before)}`)

    if (before?.permission_mode !== 'auto') {
      const up = await pool.query(
        `UPDATE agents SET permission_mode='auto' WHERE id=2 RETURNING id, name, permission_mode`
      )
      console.log(`reverted to auto: ${JSON.stringify(up.rows[0])}`)
    } else {
      console.log('already auto — no change needed')
    }

    const leftover = await pool.query(
      `SELECT id, external_id, status FROM approvals ORDER BY id DESC LIMIT 10`
    )
    console.log(`approvals rows currently present: ${leftover.rowCount}`)
    leftover.rows.forEach(r => console.log(`  ${JSON.stringify(r)}`))
  } finally {
    await pool.end()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
