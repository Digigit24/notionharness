import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

// One-off apply script for migrations/20260905_010000_media.ts — run via a
// short-lived pg.Pool, NOT `payload migrate` (which prompts interactively
// about this database's dev-push drift and hangs non-interactively; see
// AGENTS.md / scripts/apply-approvals-migration.ts for the same pattern).
// Mirrors that migration file's up() SQL exactly, then records the row in
// payload_migrations so `payload migrate:status` reports it as applied.
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "media" (
        "id" serial PRIMARY KEY,
        "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
        "uploaded_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "url" varchar,
        "thumbnail_u_r_l" varchar,
        "filename" varchar,
        "mime_type" varchar,
        "filesize" numeric,
        "width" numeric,
        "height" numeric,
        "focal_x" numeric,
        "focal_y" numeric,
        "sizes_thumbnail_url" varchar,
        "sizes_thumbnail_width" numeric,
        "sizes_thumbnail_height" numeric,
        "sizes_thumbnail_mime_type" varchar,
        "sizes_thumbnail_filesize" numeric,
        "sizes_thumbnail_filename" varchar,
        "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
        "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "media_filename_idx" ON "media" ("filename");
      CREATE INDEX IF NOT EXISTS "media_workspace_idx" ON "media" ("workspace_id");
      CREATE INDEX IF NOT EXISTS "media_uploaded_by_idx" ON "media" ("uploaded_by_id");

      ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "media_id" integer;
    `)

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'payload_locked_documents_rels_media_fk'
        ) THEN
          ALTER TABLE "payload_locked_documents_rels"
            ADD CONSTRAINT "payload_locked_documents_rels_media_fk"
            FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_media_id_idx"
        ON "payload_locked_documents_rels" ("media_id");
    `)

    const batchRes = await pool.query<{ max: string | null }>(`SELECT MAX(batch) AS max FROM payload_migrations`)
    const nextBatch = Number(batchRes.rows[0]?.max ?? 0) + 1
    await pool.query(`INSERT INTO payload_migrations (name, batch) VALUES ($1, $2)`, ['20260905_010000_media', nextBatch])

    console.log('Media schema applied: media table, indexes, payload_locked_documents_rels column.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
