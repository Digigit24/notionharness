import nextEnv from '@next/env'
nextEnv.loadEnvConfig(process.cwd())
const { Pool } = await import('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
const table = process.argv[2] ?? 'runtime_profiles'
const cols = await pool.query(
  `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
  [table],
)
console.log(`--- ${table} ---`)
for (const c of cols.rows) console.log(`${c.column_name.padEnd(28)} ${c.data_type.padEnd(26)} null=${c.is_nullable} default=${c.column_default ?? ''}`)
await pool.end()
