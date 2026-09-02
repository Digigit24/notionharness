import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

// ROADMAP B-1 (project detail, Pages tab) — prepared apply script for
// migrations/20260902_100000_pages_project.ts, mirroring
// scripts/apply-approvals-migration.ts's pattern (short-lived pg.Pool, NOT
// `payload migrate`, which prompts interactively about dev-mode drift).
//
// NOT RUN as part of this batch — see the migration file's own comment for
// why: it must land together with the matching `collections/Pages.ts`
// field addition (a `project` relationship field), which this batch also
// deliberately did not make, to avoid the running app querying a column
// that doesn't exist yet between the two steps. A human should:
//   1. Add the `project` relationship field to collections/Pages.ts
//      (relationTo: 'pages' -> 'projects', hasMany: false).
//   2. Run this script (or `payload migrate`) to apply the matching SQL.
//   3. Only then does the Pages tab's real scoped-tree implementation make
//      sense to build — this batch ships that tab as an honest "not linked
//      yet" placeholder instead.
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
  try {
    await pool.query(`
      ALTER TABLE "pages" ADD COLUMN "project_id" integer;
      ALTER TABLE "pages" ADD CONSTRAINT "pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
      CREATE INDEX "pages_project_idx" ON "pages" USING btree ("project_id");
    `)

    const batchRes = await pool.query<{ max: string | null }>(`SELECT MAX(batch) AS max FROM payload_migrations`)
    const nextBatch = Number(batchRes.rows[0]?.max ?? 0) + 1
    await pool.query(`INSERT INTO payload_migrations (name, batch) VALUES ($1, $2)`, ['20260902_100000_pages_project', nextBatch])

    console.log('pages.project_id applied: column, FK, index, payload_migrations row.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
