import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Access control and connectors — the schema the enterprise handoff is built on.
//
// FIVE TABLES, AND THE REASON EACH ONE IS SEPARATE IS IN ITS COLLECTION FILE.
// The short version: members carry a role that a flat array could not;
// invitations are keyed on a token because the person being invited usually has
// no account yet; grants are one polymorphic table because three would be three
// places for the same check to drift; a connector is configuration a workspace
// makes once, while a connection is a credential each person grants for
// themselves, and conflating those two is unrecoverable in an audit.
//
// `workspaces.members` is deliberately NOT dropped. Payload's own collection
// access rules read it, as does the workspace layout, and rewriting all of that
// in the same change that introduces roles would mean the model and the
// migration could fail together. It stays as the legacy index, kept in sync;
// `workspace_members` is the truth.
//
// The backfill is the load-bearing part: every existing workspace's owner
// becomes an `owner` row and every existing member becomes a `member` row, so
// nobody loses access the moment the permission layer starts being consulted.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "workspace_members" (
      "id" serial PRIMARY KEY,
      "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "role" varchar NOT NULL DEFAULT 'member',
      "invited_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    -- One row per person per workspace. Without this a double-click on "add
    -- member" produces two rows with two different roles and the answer to
    -- "what may they do" depends on which one a query happens to read first.
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_unique_idx"
      ON "workspace_members" ("workspace_id", "user_id");
    CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" ("user_id");

    CREATE TABLE IF NOT EXISTS "invitations" (
      "id" serial PRIMARY KEY,
      "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "email" varchar NOT NULL,
      "role" varchar NOT NULL DEFAULT 'member',
      "token" varchar NOT NULL,
      "status" varchar NOT NULL DEFAULT 'pending',
      "invited_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "accepted_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "expires_at" timestamp(3) with time zone NOT NULL,
      "channel_id" bigint,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    -- The token IS the credential in the link, so it must be unique and it must
    -- be indexed: the accept path looks a row up by nothing else.
    CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_idx" ON "invitations" ("token");
    CREATE INDEX IF NOT EXISTS "invitations_workspace_idx" ON "invitations" ("workspace_id");
    CREATE INDEX IF NOT EXISTS "invitations_email_idx" ON "invitations" ("email");

    CREATE TABLE IF NOT EXISTS "access_grants" (
      "id" serial PRIMARY KEY,
      "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "object_type" varchar NOT NULL,
      "object_id" varchar NOT NULL,
      "subject_user_id" integer REFERENCES "users"("id") ON DELETE CASCADE,
      "subject_agent_id" integer REFERENCES "agents"("id") ON DELETE CASCADE,
      "role" varchar NOT NULL DEFAULT 'viewer',
      "granted_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      -- Exactly one subject. A row with both would be two grants pretending to
      -- be one, and a row with neither grants nothing to nobody.
      CONSTRAINT "access_grants_one_subject" CHECK (
        ("subject_user_id" IS NOT NULL AND "subject_agent_id" IS NULL) OR
        ("subject_user_id" IS NULL AND "subject_agent_id" IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS "access_grants_object_idx" ON "access_grants" ("object_type", "object_id");
    CREATE INDEX IF NOT EXISTS "access_grants_subject_user_idx" ON "access_grants" ("subject_user_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "access_grants_unique_user_idx"
      ON "access_grants" ("object_type", "object_id", "subject_user_id")
      WHERE "subject_user_id" IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS "access_grants_unique_agent_idx"
      ON "access_grants" ("object_type", "object_id", "subject_agent_id")
      WHERE "subject_agent_id" IS NOT NULL;

    CREATE TABLE IF NOT EXISTS "connectors" (
      "id" serial PRIMARY KEY,
      "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "provider" varchar NOT NULL DEFAULT 'composio',
      "toolkit_slug" varchar NOT NULL,
      "name" varchar NOT NULL,
      "scope_type" varchar NOT NULL DEFAULT 'workspace',
      "scope_id" varchar,
      "auth_config_id" varchar,
      "allowed_tools" jsonb DEFAULT '[]'::jsonb,
      "enabled" boolean DEFAULT true,
      "created_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "connectors_workspace_idx" ON "connectors" ("workspace_id");
    CREATE INDEX IF NOT EXISTS "connectors_scope_idx" ON "connectors" ("scope_type", "scope_id");

    CREATE TABLE IF NOT EXISTS "connections" (
      "id" serial PRIMARY KEY,
      "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "toolkit_slug" varchar NOT NULL,
      "composio_connected_account_id" varchar,
      "status" varchar NOT NULL DEFAULT 'pending',
      "status_detail" varchar,
      "redirect_url" varchar,
      "requested_by_run" bigint,
      "last_checked_at" timestamp(3) with time zone,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    -- One live connection per person per toolkit per workspace. A second one is
    -- always a half-finished auth flow, and letting two exist means an agent
    -- can pick the dead one.
    CREATE UNIQUE INDEX IF NOT EXISTS "connections_unique_idx"
      ON "connections" ("workspace_id", "user_id", "toolkit_slug");
    CREATE INDEX IF NOT EXISTS "connections_account_idx" ON "connections" ("composio_connected_account_id");

    -- BYOK: the workspace's own Composio key. Falls back to COMPOSIO_API_KEY in
    -- the environment when unset, which is what makes a single-tenant install
    -- work with no setup at all.
    ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "composio_api_key" varchar;
  `)

  // The backfill. Owners first, then members — `ON CONFLICT DO NOTHING` so an
  // owner who is also listed in `members` keeps the stronger role.
  await db.execute(sql`
    INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
    SELECT "id", "owner_id", 'owner' FROM "workspaces" WHERE "owner_id" IS NOT NULL
    ON CONFLICT ("workspace_id", "user_id") DO NOTHING;
  `)

  // `workspaces.members` is a Payload `hasMany` relationship, which it stores in
  // a side table. Read it defensively: an install whose table is named
  // differently must not fail the whole migration, because the owner rows above
  // are what actually keep people in.
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workspaces_rels') THEN
        INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
        SELECT r."parent_id", r."users_id", 'member'
          FROM "workspaces_rels" r
         WHERE r."path" = 'members' AND r."users_id" IS NOT NULL
        ON CONFLICT ("workspace_id", "user_id") DO NOTHING;
      END IF;
    END $$;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "connections";
    DROP TABLE IF EXISTS "connectors";
    DROP TABLE IF EXISTS "access_grants";
    DROP TABLE IF EXISTS "invitations";
    DROP TABLE IF EXISTS "workspace_members";
    ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "composio_api_key";
  `)
}
