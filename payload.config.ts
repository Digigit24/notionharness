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
import { RuntimeProfiles } from './collections/RuntimeProfiles'
import { Runtimes } from './collections/Runtimes'
import { Agents } from './collections/Agents'
import { Approvals } from './collections/Approvals'
import { SavedViews } from './collections/SavedViews'

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
    RuntimeProfiles,
    Runtimes,
    Agents,
    Approvals,
    SavedViews,
  ],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || '',
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
