import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// R14-P0.4 — the Media collection, hand-written for the same reason every
// other migration in this repo since `20260902_090000_approvals` has been:
// `payload migrate`/`migrate:create` prompt interactively about this
// database's dev-push drift and hang non-interactively (confirmed again this
// session — `migrate:create` sat on "Is databases table created or renamed
// from another table?" waiting for stdin that never comes). This mirrors
// EXACTLY the columns `getBaseUploadFields` (payload/dist/uploads/
// getBaseFields.js, read directly rather than guessed) generates for
// `upload: true` plus one `imageSizes` entry named `thumbnail`, plus this
// collection's own two fields.
//
// Column-to-field mapping, so a future reader does not have to re-derive it:
//   url, thumbnailURL, filename, mimeType   -> text fields  -> varchar
//   filesize, width, height, focalX, focalY -> number fields -> numeric
//     (matches `artifacts.session`/`artifacts.run` in 20260904_artifacts.sql,
//     whose own comment names this exact mapping)
//   sizes.thumbnail.{url,width,height,mimeType,filesize,filename}
//     -> a `group` field, which the postgres adapter flattens into
//        `sizes_thumbnail_*` columns rather than a JSON column or a related
//        table — only `array`/`blocks` fields get their own table.
//   workspace, uploadedBy -> relationship (hasMany: false) -> `<name>_id`
//     integer FK, same convention as every other collection here.
//
// VERIFIED LIVE, not merely derived: applied once via
// `scripts/apply-media-migration.ts` against this shared database and
// exercised with a real `payload.create({ collection: 'media', file: ... })`
// call before this file was considered done (see this unit's own test
// script, `scripts/test-media-attachments.ts`).
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "media" (
      "id" serial PRIMARY KEY,
      "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "uploaded_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "url" varchar,
      -- NOT "thumbnail_url". Payload's field-name-to-column-name conversion
      -- treats every letter of an all-caps run as its own boundary, so the
      -- 'thumbnailURL' field (payload/dist/uploads/getBaseFields.js) becomes
      -- "thumbnail_u_r_l", not the "thumbnail_url" a human would guess.
      -- CONFIRMED THE HARD WAY: an initial hand-written "thumbnail_url"
      -- column made every payload.create/find on this collection fail with
      -- 'column "thumbnail_u_r_l" does not exist' the first time this was
      -- exercised live — see scripts/test-media-attachments.ts.
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
    -- Payload's own default for an upload collection with no
    -- filenameCompoundIndex — one filename, once, across the whole library.
    CREATE UNIQUE INDEX IF NOT EXISTS "media_filename_idx" ON "media" ("filename");
    CREATE INDEX IF NOT EXISTS "media_workspace_idx" ON "media" ("workspace_id");
    CREATE INDEX IF NOT EXISTS "media_uploaded_by_idx" ON "media" ("uploaded_by_id");

    -- Payload's polymorphic document-locking relation needs a column and an FK
    -- per collection that can be locked, the same wiring
    -- 20260903_140000_project_resources's own note describes having to get
    -- right for a brand-new collection.
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "media_id" integer;
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
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_media_id_idx"
      ON "payload_locked_documents_rels" ("media_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "media_id";
    DROP TABLE IF EXISTS "media";
  `)
}
