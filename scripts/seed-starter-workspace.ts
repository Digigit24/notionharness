/**
 * ROADMAP B8.5 (Batch B-6 "Finish") — the empty-product problem: "A fresh
 * workspace currently shows nothing. Seed it: a starter project, a sample
 * page demonstrating the agentic blocks, one preconfigured agent, and a
 * first task that produces a real run."
 *
 * The actual seeding logic now lives in `lib/onboarding/seed-starter-
 * workspace.ts` (Phase C, C4 — "wire it into first-run"), extracted so a
 * real server action in the live app can call it safely; see that file's
 * own header comment for exactly why this file couldn't just be imported
 * directly (short version: this file's CLI entry point used to run
 * unconditionally at module load and close the shared broker pool as a
 * side effect — fine for a script always invoked via `tsx`, not safe to
 * import from a running server). This file is now purely the CLI wrapper:
 * argument parsing, the confirmation-flag gate, and the standalone
 * process's own env loading / pool teardown.
 *
 * ============================================================================
 * WRITTEN, NOT RUN (as a standalone script). Do not execute this file
 * directly in this batch or session — the live-app path
 * (`lib/onboarding/seed-starter-workspace.ts` called from a server action)
 * is the one this session actually verified. Per this repo's own standing
 * DB-safety rule (AGENTS.md: "never run a standalone script that calls
 * getPayloadClient() against this shared DB"), running this file directly
 * opens a second connection pool against the shared, connection-capped
 * Supabase instance — the exact thing that rule warns against.
 * ============================================================================
 * Running it without the `--i-understand-this-writes-to-the-shared-db`
 * flag is a no-op that only prints what it *would* do. There is no
 * default-on path.
 *
 * Usage: `npx tsx scripts/seed-starter-workspace.ts --workspace-slug=<slug>
 * --user-email=<email> --i-understand-this-writes-to-the-shared-db`
 *
 * Idempotency: NOT fully idempotent — re-running against a workspace this
 * already seeded creates a second "Getting Started" project, a second
 * sample page, etc. `lib/onboarding/seed-starter-workspace.ts` checks for
 * an existing task-status set before creating one, but does not otherwise
 * detect "already seeded." The live-app server action this session added
 * guards this the other way — it only runs when the workspace's own
 * `isGenuinelyEmpty` check (workspace home page) is true — but this CLI
 * path has no such guard of its own; the human running it is the guard.
 */
import nextEnv from '@next/env'
import { getPayloadClient } from '../lib/payload'
import { closeBrokerPool } from '../lib/broker'
import { seedStarterWorkspace } from '../lib/onboarding/seed-starter-workspace'

nextEnv.loadEnvConfig(process.cwd())

async function resolveWorkspaceAndUserIds(workspaceSlug: string, userEmail: string) {
  const payload = await getPayloadClient()
  const workspaceRes = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: workspaceSlug } },
    limit: 1,
    overrideAccess: true,
  })
  const workspace = workspaceRes.docs[0]
  if (!workspace) {
    throw new Error(`No workspace with slug "${workspaceSlug}" — this seeds an EXISTING workspace, it does not create one.`)
  }

  const userRes = await payload.find({
    collection: 'users',
    where: { email: { equals: userEmail } },
    limit: 1,
    overrideAccess: true,
  })
  const user = userRes.docs[0]
  if (!user) throw new Error(`No user with email "${userEmail}".`)

  return { workspaceId: workspace.id, userId: user.id }
}

// --- CLI entry point — a no-op without the explicit confirmation flag. ---
async function main() {
  const args = process.argv.slice(2)
  const confirmed = args.includes('--i-understand-this-writes-to-the-shared-db')
  const workspaceSlug = args.find((a) => a.startsWith('--workspace-slug='))?.split('=')[1]
  const userEmail = args.find((a) => a.startsWith('--user-email='))?.split('=')[1]

  if (!confirmed || !workspaceSlug || !userEmail) {
    console.log(
      [
        'seed-starter-workspace: dry-run (no confirmation flag / missing args — nothing was written).',
        '',
        'Usage:',
        '  npx tsx scripts/seed-starter-workspace.ts \\',
        '    --workspace-slug=<slug> --user-email=<email> \\',
        '    --i-understand-this-writes-to-the-shared-db',
        '',
        'This creates real rows in the shared DB (project, runtime profile,',
        'agent, task statuses if missing, a database + 2 rows, a task, a',
        'queued run, and a page) — read this file\'s header comment first.',
      ].join('\n'),
    )
    return
  }

  const { workspaceId, userId } = await resolveWorkspaceAndUserIds(workspaceSlug, userEmail)
  const result = await seedStarterWorkspace({ workspaceId, userId })
  console.log('Seeded starter workspace content:', {
    projectId: result.project.id,
    agentId: result.agent.id,
    taskId: result.task.id,
    runId: result.run.id,
    pageId: result.page.id,
  })
}

// Matches every other script in this directory's convention (`main()`
// called unconditionally, no `require.main`/import-guard) — these scripts
// are always invoked directly via `tsx scripts/<name>.ts`, never imported
// as a module elsewhere, so the confirmation-flag check inside `main()`
// itself (above) is what actually keeps this safe to load, not this line.
main()
  .catch((err) => {
    console.error('seed-starter-workspace failed:', err)
    process.exitCode = 1
  })
  .finally(() => void closeBrokerPool())
