import { readFileSync } from 'node:fs'
import nextEnv from '@next/env'
nextEnv.loadEnvConfig(process.cwd())
const { Pool } = await import('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
const sql = process.argv[2]?.endsWith('.sql') ? readFileSync(process.argv[2], 'utf8') : process.argv[2]
const r = await pool.query(sql)
console.table(r.rows)
await pool.end()
