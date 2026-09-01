# Postgres consolidation plan (NotionForge → TeamOS Supabase)

Status: planning only. This document does not authorize a cutover, change
`DATABASE_URI`, or run SQL against either project.

## Scope and current state

Pillar 1.3 calls for one data plane: move NotionForge and its future broker to
the TeamOS Supabase project. The projects are currently separate:

- NotionForge: hosted Supabase ref `vktoyabztcowzmwyrxkv`.
- TeamOS: hosted Supabase ref beginning `xnhmmy`.

The target already contains TeamOS migrations `001_teamos_tenancy.sql` and
`002_teamos_messages.sql`. They create `teamos_schema_migrations`,
`teamos_persons`, `teamos_memberships`, `teamos_copilots`,
`organization_channel_identities`, `organization_copilot_grants`, and
`teamos_messages`. All of those tables have a distinctive `teamos_` prefix
except the two intentionally organization-scoped identity/grant tables.

NotionForge currently has Payload-owned tables `users`, `users_sessions`,
`workspaces`, `workspaces_rels`, `pages`, `teable_databases`, and Payload
support tables (`payload_kv`, `payload_locked_documents` and its `_rels`
table, `payload_preferences` and its `_rels` table, and
`payload_migrations`). Better Auth owns its own `user`, `session`, `account`,
and `verification` tables in the current database. Those are distinct from
Payload's plural `users` table and must be preserved. The future broker will
use raw `pg` for `runs`, `run_messages`, and `run_usage`, as required by the
roadmap's claim/lease semantics.

## Namespace and ownership model

Use one explicit ownership manifest before migration:

| Owner | Tables | Access path |
| --- | --- | --- |
| TeamOS | `teamos_schema_migrations`, `teamos_*`, `organization_*` | TeamOS SQL/API, existing RLS |
| NotionForge Payload | `users`, `users_sessions`, `workspaces`, `workspaces_rels`, `pages`, `teable_databases`, `payload_*` | Payload Local API and Payload migrations |
| NotionForge Better Auth | `user`, `session`, `account`, `verification` (plus any version-specific auth support tables) | Better Auth adapter/API |
| NotionForge broker | `runs`, `run_messages`, `run_usage` | short-lived/raw `pg`, broker migrations |

Do not rename or reuse TeamOS tables. The current TeamOS names do not collide
with Payload, Better Auth, or the planned broker names. Before cutover, query
`pg_catalog.pg_class` and `information_schema.columns` on the target and fail
the operation if any broker or Payload table already exists with an
unexpected shape. Also check constraint/index names: PostgreSQL constraint
and index names are schema-scoped, so broker migrations should use a stable
prefix such as `nf_runs_*`, and generated Payload names must be compared
before applying them.

Keep all tables in `public` for this first consolidation only if the target's
operational policy permits it; ownership is enforced by application roles and
RLS, not by name alone. A future security hardening can move broker tables to
`notionforge` while retaining compatibility views, but that is out of scope
for this cutover. In particular, do not add RLS policies to Payload tables
without designing how the server-side Payload role bypasses them. TeamOS
tables retain their existing RLS policies and should not be altered by
Payload migrations.

## Migration compatibility

`payload.config.ts` already sets `push: false`. Keep that setting. Payload's
generated migrations are the source of truth for Payload-owned tables, while
the existing TeamOS SQL migration history remains the source of truth for
TeamOS-owned tables. Payload must be run with its migration commands against
the target only after a schema preflight; never use dev-mode auto-push.

The independent migration ledgers are safe because TeamOS uses
`teamos_schema_migrations(version, applied_at)` and Payload uses
`payload_migrations(id, name, batch, updated_at, created_at)`. Do not merge
these ledgers or ask Payload to introspect/manage TeamOS tables. Similarly,
Better Auth's tables are outside Payload's collection config and must not be
treated as drift or deletion candidates. Broker SQL migrations should have a
third, explicit ledger (for example `notionforge_broker_schema_migrations`)
or be managed by the broker's migration runner; they must never be silently
run by Payload.

Before changing the target, compare the complete generated Payload schema
(including enum types, foreign keys, indexes, and relation tables) with the
current NotionForge database. If the target has an object with the same name,
stop for a manual shape/data decision—do not let an interactive destructive
prompt decide. Apply TeamOS migrations first (if the target is not already at
their recorded versions), then Payload migrations, then Better Auth's
adapter/schema migration, and finally broker migrations when the broker is
actually being deployed.

## Proposed cutover procedure (future, explicitly approved operation)

1. **Approve and freeze.** Obtain explicit approval for a maintenance window,
   record the source and target project refs, and stop writes to NotionForge.
   Keep the TeamOS app running read-only or stop it during schema changes.
2. **Inventory and preflight.** Export the target table/column/index/RLS
   inventory and migration ledgers. Check the collision list above, confirm
   the TeamOS migration versions, and record current connection usage.
3. **Back up NotionForge.** Take a provider snapshot if available and a
   `pg_dump --format=custom --no-owner --no-acl` of the current NotionForge
   database. Separately export Better Auth data and verify the dump by listing
   its tables and restoring it into a disposable database. Preserve secrets
   and encryption keys required to interpret auth records.
4. **Prepare target.** Take a target snapshot/export. Apply or verify the two
   TeamOS migrations through TeamOS's migration runner; do not edit their
   SQL. Ensure the deploy role can create Payload objects but cannot drop
   unrelated TeamOS/auth objects.
5. **Load NotionForge data.** Restore only the NotionForge-owned data into the
   target (or use table-scoped dumps), preserving IDs and sequences. Do not
   overwrite TeamOS tables. Restore Better Auth tables/data using the
   adapter-supported procedure, preserving its hashes, sessions, and keys.
6. **Apply schema.** With `push: false`, run Payload's committed migrations
   and inspect every statement/output. Then run the approved Better Auth and
   broker migrations. No command may be allowed to answer a data-loss prompt
   automatically.
7. **Repoint and restart.** Change `DATABASE_URI` only in the deployment
   secret/config after all checks pass, restart the canonical app, and ensure
   no old source-database workers are still writing. Never commit credentials.
8. **Verify.** Test login/session creation, workspace/page CRUD, Teable
   database links, migrations, TeamOS tenancy/message reads, and broker
   enqueue/claim/lease/recovery semantics. Compare row counts, ID ranges,
   foreign-key checks, and representative checksums against the backup.
9. **Release writes.** Enable TeamOS and NotionForge writes only after smoke
   tests pass; monitor errors, pool utilization, lock waits, and auth failures
   throughout the first write window.

### Rollback

If any schema, auth, integrity, or performance check fails, stop writes and
repoint `DATABASE_URI` to the unchanged NotionForge source. Restart workers
and the app, invalidate any sessions created against the target if needed,
and preserve target logs/snapshots for diagnosis. Do not run down migrations
on the target as an emergency rollback: they can destroy newly written data
and could affect TeamOS if a mistake crossed ownership boundaries. Reconcile
any writes made during a failed window from an append-only audit/export before
attempting another cutover. Keep the source available until a documented
acceptance window has passed.

## Connection-pool budget

The TeamOS target is a small Supabase tier and the TeamOS app already consumes
connections. Treat the pooler ceiling as a shared budget, not as a per-app
allowance. Before cutover, measure `pg_stat_activity` by application/user and
record the provider's session-mode and transaction-mode limits. Reserve a
small emergency margin (at least 2 connections) for migrations, health checks,
and provider services.

For a conservative session-mode budget:

```
usable = provider_limit - provider_reserved - emergency_margin
NotionForge_max + TeamOS_max + broker_max <= usable
```

Start with Payload/Next at `max: 3`, TeamOS at its measured pool size, and the
broker at `max: 2`; reduce each if the inequality does not hold. Account for
each separately running process (web, worker, migration command, scripts), not
just each repository. One-off scripts must be short-lived and close pools.
Prefer the provider's transaction-mode pooler for bursty stateless HTTP work
only after confirming the ORM/transaction behavior is compatible; keep
long-lived session requirements isolated and documented. Alert at 70% pool
usage and reject new workers before saturation. Never solve exhaustion by
silently increasing pool sizes or launching another dev server.

## Acceptance checklist

- [ ] Explicit cutover approval and maintenance window recorded.
- [ ] Source and target snapshots plus verified disposable restore completed.
- [ ] Collision/preflight report has no unexpected objects or shape drift.
- [ ] TeamOS migrations and RLS policies unchanged and healthy.
- [ ] Payload migrations applied with `push: false`; no auto-push prompt used.
- [ ] Better Auth tables, hashes, sessions, and adapter migration verified.
- [ ] Broker tables use raw `pg`, separate migration ownership, and claim/lease tests.
- [ ] Row counts, foreign keys, login, CRUD, and representative checksums match.
- [ ] Pool budget and rollback procedure tested before enabling writes.
