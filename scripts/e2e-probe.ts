// Final probe before the e2e.
import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 2 })
  try {
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' ORDER BY ordinal_position`
    )).rows
    console.log('tasks.columns:', cols.map(c => c.column_name).join(','))
    const colsR = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='runs' ORDER BY ordinal_position`
    )).rows
    console.log('runs.columns:', colsR.map(c => c.column_name).join(','))

    const tasks = await pool.query(`SELECT id, workspace_id, title FROM tasks ORDER BY id ASC LIMIT 5`)
    console.log('tasks:', JSON.stringify(tasks.rows, null, 2))

    const runs = await pool.query(
      `SELECT id, status, task_id, agent_id, accountable_user, page_id, run_token,
              prompt, created_at, updated_at FROM runs ORDER BY id DESC LIMIT 5`
    )
    console.log('runs:', JSON.stringify(runs.rows, null, 2))

    const rp = await pool.query(`SELECT * FROM runtime_profiles ORDER BY id ASC`)
    console.log('runtime_profiles:', JSON.stringify(rp.rows, null, 2))

    const users = await pool.query(`SELECT id, email FROM users ORDER BY id ASC`)
    console.log('users (payload):', JSON.stringify(users.rows, null, 2))

    const baUsers = await pool.query(`SELECT id, email FROM "user" ORDER BY id ASC`)
    console.log('better-auth user:', JSON.stringify(baUsers.rows, null, 2))

    const accs = await pool.query(`SELECT id, account_id, provider_id, user_id FROM account ORDER BY id ASC`)
    console.log('account:', JSON.stringify(accs.rows, null, 2))

    const sessions = await pool.query(`SELECT token, userid, expires_at FROM session ORDER BY expires_at DESC LIMIT 3`)
    console.log('better-auth sessions:', JSON.stringify(sessions.rows, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
