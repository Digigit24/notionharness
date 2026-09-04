// Adds `workspace` to the `activity.entity_type` Postgres enum.
//
// `npx payload migrate` does not complete in this environment (it hangs before
// running anything, reproducibly), so the statement is executed through the
// broker pool instead. `migrations/20260904_210000_activity_workspace_entity_type.ts`
// carries the same statement so a fresh install is correct; `ADD VALUE IF NOT
// EXISTS` is idempotent, so running this and later running the Payload
// migration is safe in either order.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')

const pool = getBrokerPool()

try {
  // Not wrapped in a transaction, deliberately: Postgres refuses
  // `ALTER TYPE ... ADD VALUE` inside a transaction block on the versions this
  // project supports, and node-postgres runs a bare `query` in autocommit.
  await pool.query(`ALTER TYPE "public"."enum_activity_entity_type" ADD VALUE IF NOT EXISTS 'workspace'`)

  const { rows } = await pool.query<{ value: string }>(
    `SELECT e.enumlabel AS value
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'enum_activity_entity_type'
      ORDER BY e.enumsortorder`,
  )
  const values = rows.map((row) => row.value)
  console.log(`enum_activity_entity_type = [${values.join(', ')}]`)
  console.log(values.includes('workspace') ? 'PASS  workspace is present' : 'FAIL  workspace is missing')
  process.exitCode = values.includes('workspace') ? 0 : 1
} finally {
  await closeBrokerPool()
}
