import path from 'path'
import { fileURLToPath } from 'url'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { Users } from './collections/Users'
import { Workspaces } from './collections/Workspaces'
import { Pages } from './collections/Pages'
import { Databases } from './collections/Databases'
import { DatabaseRows } from './collections/DatabaseRows'
import { Projects } from './collections/Projects'
import { TaskStatuses } from './collections/TaskStatuses'
import { Tasks } from './collections/Tasks'
import { TaskLinks } from './collections/TaskLinks'
import { Followers } from './collections/Followers'
import { Comments } from './collections/Comments'
import { Activity } from './collections/Activity'
import { Notifications } from './collections/Notifications'
import { Artifacts } from './collections/Artifacts'
import { Plugins } from './collections/Plugins'
import { RuntimeProfiles } from './collections/RuntimeProfiles'
import { Runtimes } from './collections/Runtimes'
import { Agents } from './collections/Agents'
import { Approvals } from './collections/Approvals'
import { SavedViews } from './collections/SavedViews'
import { PushSubscriptions } from './collections/PushSubscriptions'
import { NotificationPreferences } from './collections/NotificationPreferences'
import { WorkspaceMembers } from './collections/WorkspaceMembers'
import { Invitations } from './collections/Invitations'
import { AccessGrants } from './collections/AccessGrants'
import { Connectors } from './collections/Connectors'
import { Connections } from './collections/Connections'
import { ProjectResources } from './collections/ProjectResources'
import { HermesConfig } from './globals/HermesConfig'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [
    Users,
    Workspaces,
    Pages,
    Databases,
    DatabaseRows,
    Projects,
    TaskStatuses,
    Tasks,
    TaskLinks,
    Followers,
    Comments,
    Activity,
    Notifications,
    Artifacts,
    Plugins,
    RuntimeProfiles,
    Runtimes,
    Agents,
    Approvals,
    SavedViews,
    PushSubscriptions,
    NotificationPreferences,
    ProjectResources,
    // Access control and connectors. Order is cosmetic (it drives the admin
    // sidebar), but members/invitations/grants belong together and the two
    // connector tables belong together, because reading one without the other
    // is how the connector-versus-connection distinction gets lost.
    WorkspaceMembers,
    Invitations,
    AccessGrants,
    Connectors,
    Connections,
  ],
  globals: [HermesConfig],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  cors: [
    'http://localhost:3000',
    'http://digitech.tail7572d2.ts.net:3000',
  ],
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || '',
      // Left unset, node-postgres's own `Pool` defaults `max` to 10 — this
      // process ALSO opens `lib/broker/db.ts`'s separate raw-pg pool
      // (currently `max: 3`) and `lib/auth.ts`'s (`max: 2`) for the same
      // shared Supabase instance, whose session-mode cap is ~15 (confirmed
      // live: "max clients reached in session mode"). 7 (down from 8) + 3 +
      // 2 = 12, leaving real headroom — a prior 8+6=14 (before auth's pool
      // was accounted for) and then 8+4+3=15 both stopped the outright
      // crashing but still left zero room: confirmed live that all 15 slots
      // sat idle-but-held by these three pools' own warm connections, so a
      // single extra burst (one more page load, one ad-hoc script) timed
      // out waiting rather than actually being denied at the DB.
      max: 7,
      // Without this, a query that can't get a connection because this pool
      // (or a sibling one — lib/auth.ts, lib/broker/db.ts) is at `max` waits
      // forever with node-postgres's default (no timeout) — silently, no
      // thrown error, no console output. Confirmed live: connections sat at
      // 15/15 (this instance's real session-mode cap) with active queries
      // contending, right when a "blank white screen after login, nothing
      // in the console" report came in — exactly the failure mode a hung
      // connection-acquire produces (the workspace home page alone fires
      // ~13 parallel queries). Failing loud after 8s turns that into a
      // visible, debuggable error instead of an indefinite blank page.
      connectionTimeoutMillis: 8_000,
    },
    // Migrations are the source of truth for this project (see `migrations/`).
    // Without this, Payload's dev-mode schema-drift auto-push kicks in on every
    // fresh client init and prompts interactively when the live DB has tables
    // it doesn't recognize (e.g. Better Auth's own tables) — that prompt hangs
    // forever in a non-interactive script and, worse, offers to DROP unknown
    // tables if confirmed. Disabling push forces migration-only schema changes.
    push: false,
  }),
  sharp,
})
