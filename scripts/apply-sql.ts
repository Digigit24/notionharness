// Apply a .sql file against the app database.
//
// Every schema change in this project goes through additive SQL rather than
// `payload migrate`, because this database was created by dev-mode push and
// the migration runner refuses to touch it. Scripts written for this must be
// idempotent — this runner offers no rollback and is expected to be re-run.
//
//   npx tsx scripts/apply-sql.ts path/to/file.sql
import { readFileSync } from 'node:fs'

import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const file = process.argv[2]
if (!file) throw new Error('Usage: npx tsx scripts/apply-sql.ts <file.sql>')

const { Pool } = await import('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
try {
  await pool.query(readFileSync(file, 'utf8'))
  console.log(`Applied ${file}`)
} finally {
  await pool.end()
}
