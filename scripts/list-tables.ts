import nextEnv from '@next/env'
nextEnv.loadEnvConfig(process.cwd())
const { Pool } = await import('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
const r = await pool.query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name LIKE $1 ORDER BY table_name`,
  [process.argv[2] ?? '%'],
)
console.log(r.rows.map((x) => x.table_name).join('\n'))
await pool.end()
