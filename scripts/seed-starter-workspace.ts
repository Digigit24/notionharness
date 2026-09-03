/**
 * ROADMAP B8.5 (Batch B-6 "Finish") — the empty-product problem: "A fresh
 * workspace currently shows nothing. Seed it: a starter project, a sample
 * page demonstrating the agentic blocks, one preconfigured agent, and a
 * first task that produces a real run."
 *
 * ============================================================================
 * WRITTEN, NOT RUN. Do not execute this script in this batch or session.
 * ============================================================================
 * Per this repo's own standing DB-safety rule (AGENTS.md: "never run a
 * standalone script that calls getPayloadClient() against this shared DB")
 * and this batch's explicit hard rules, this script is reviewable source
 * only. As a second, structural safeguard beyond that written rule — not a
 * substitute for a human actually reading this file first — running it
 * without the `--i-understand-this-writes-to-the-shared-db` flag is a no-op
 * that only prints what it *would* do. There is no default-on path.
 *
 * When a human does run it (after schema is confirmed fully migrated, per
 * the same AGENTS.md note): `npx tsx scripts/seed-starter-workspace.ts
 * --workspace-slug=<slug> --user-email=<email> --i-understand-this-writes-to-the-shared-db`
 *
 * What it creates, in an already-existing, genuinely empty workspace
 * (identified by `--workspace-slug`; this script does NOT create the
 * workspace itself — workspace creation already exists via the real
 * `createWorkspace` action, and duplicating that here would be a second
 * source of truth for it):
 *   1. A "Getting Started" project.
 *   2. A runtime profile + one preconfigured agent ("Starter agent"),
 *      pointed at `HERMES_ACP_BIN` (same env var `scripts/test-run-usage.ts`
 *      already uses) — left DISABLED (`enabled: false`) by default, since a
 *      seeded agent pointed at a binary path that may not exist on whatever
 *      machine this actually runs on must not silently look "ready" when
 *      it isn't; a human flips it on once they've confirmed the binary path
 *      for real (the first-run checklist's "connect a provider" step, see
 *      `components/home/first-run-checklist.tsx`, treats this the same way
 *      the real onboarding flow would).
 *   3. A tiny starter task-status set (Backlog/To do/In Progress/Done) if
 *      the workspace has none yet — every other seeded object needs a
 *      `status`, and this script must not assume the workspace already has
 *      one, since "genuinely empty" is exactly the case this seeds for.
 *   4. A sample page ("Welcome") demonstrating this session's own new
 *      blocks: a real `affine:embed-task` block (linked to the seeded
 *      task, item 5), a real `affine:embed-teable-native` block backed by a
 *      fresh `databases` doc (2 sample rows, D3/D4-compliant — never the
 *      stock `affine:database` block, per AGENTS.md), and — once the first
 *      task's run exists — a real `affine:embed-run-card` block for it.
 *   5. A first task ("Try your first run") in the Getting Started project,
 *      status = the seeded "To do" status, `createdBy` = the resolved user.
 *   6. One real run for that task, via `enqueueRun` (the exact same broker
 *      call `updateTaskFields`'s "setting agent enqueues a run" path uses —
 *      see AGENTS.md's B-0 command-bar note) — status starts `queued`; it
 *      only actually executes once a real dispatcher loop and a working
 *      `HERMES_ACP_BIN` are both present, which is exactly why the agent
 *      seeded in step 2 starts disabled rather than claiming to be ready.
 *
 * Idempotency: NOT fully idempotent — re-running against a workspace this
 * script already seeded will create a second "Getting Started" project, a
 * second sample page, etc. It checks for an existing task-status set (step
 * 3) before creating one, but does not otherwise detect "already seeded."
 * A production version of this would want a marker (e.g. a `seededAt` field
 * on `workspaces`, which does not exist today) — left as a follow-up rather
 * than adding a schema change to a script that isn't being run this batch.
 */
import nextEnv from '@next/env'
import { join } from 'node:path'
import { getPayloadClient } from '../lib/payload'
import { enqueueRun, closeBrokerPool } from '../lib/broker'
import { loadDoc, seedEmptyDoc, encodeDocUpdate } from '../lib/blocksuite-doc'
import { Text } from '../lib/blocksuite-store'
import type { Payload } from 'payload'
import type { TaskStatus } from '../payload-types'

nextEnv.loadEnvConfig(process.cwd())

// Phase C, C1.0 — no hardcoded machine path here anymore (there was one —
// a different developer's own hermes-acp path — until it was confirmed to
// name a machine other than whichever one actually runs this script);
// derived from the required `HERMES_HOME_BASE` instead.
const HERMES_ACP_BIN =
  process.env.HERMES_ACP_BIN ??
  (process.env.HERMES_HOME_BASE
    ? join(process.env.HERMES_HOME_BASE, 'hermes-agent', 'venv', 'Scripts', 'hermes-acp.exe')
    : (() => {
        throw new Error('Set HERMES_ACP_BIN or HERMES_HOME_BASE so this script can find the hermes-acp binary.')
      })())

interface SeedOptions {
  workspaceSlug: string
  userEmail: string
}

async function resolveWorkspaceAndUser(payload: Payload, opts: SeedOptions) {
  const workspaceRes = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: opts.workspaceSlug } },
    limit: 1,
    overrideAccess: true,
  })
  const workspace = workspaceRes.docs[0]
  if (!workspace) throw new Error(`No workspace with slug "${opts.workspaceSlug}" — this script seeds an EXISTING workspace, it does not create one.`)

  const userRes = await payload.find({
    collection: 'users',
    where: { email: { equals: opts.userEmail } },
    limit: 1,
    overrideAccess: true,
  })
  const user = userRes.docs[0]
  if (!user) throw new Error(`No user with email "${opts.userEmail}".`)

  return { workspace, user }
}

async function ensureTaskStatuses(payload: Payload, workspaceId: number) {
  const existing = await payload.find({
    collection: 'task-statuses',
    where: { workspace: { equals: workspaceId } },
    limit: 1,
    overrideAccess: true,
  })
  if (existing.docs.length > 0) {
    // Already has statuses — reuse the first "todo"-category one (or the
    // first status at all) rather than seeding a second, competing set.
    const all = await payload.find({ collection: 'task-statuses', where: { workspace: { equals: workspaceId } }, limit: 20, overrideAccess: true })
    return all.docs.find((s) => s.category === 'todo') ?? all.docs[0]
  }

  const specs: Array<{ name: string; category: NonNullable<TaskStatus['category']>; position: number }> = [
    { name: 'Backlog', category: 'backlog', position: 0 },
    { name: 'To do', category: 'todo', position: 1 },
    { name: 'In Progress', category: 'inProgress', position: 2 },
    { name: 'Done', category: 'done', position: 3 },
  ]
  let todoStatus: Awaited<ReturnType<typeof payload.create>> | null = null
  for (const spec of specs) {
    const created = await payload.create({
      collection: 'task-statuses',
      data: { workspace: workspaceId, name: spec.name, category: spec.category, position: spec.position },
      overrideAccess: true,
    })
    if (spec.category === 'todo') todoStatus = created
  }
  if (!todoStatus) throw new Error('Failed to seed a "todo"-category status.')
  return todoStatus
}

export async function seedStarterWorkspace(opts: SeedOptions) {
  const payload = await getPayloadClient()
  const { workspace, user } = await resolveWorkspaceAndUser(payload, opts)

  // 1. Starter project.
  const project = await payload.create({
    collection: 'projects',
    data: {
      workspace: workspace.id,
      name: 'Getting Started',
      icon: '🚀',
      description: 'A few real things to try — a sample document, a preconfigured agent, and a first task.',
    },
    overrideAccess: true,
  })

  // 2. Runtime profile + one preconfigured (but disabled) agent.
  const runtimeProfile = await payload.create({
    collection: 'runtime-profiles',
    data: {
      workspace: workspace.id,
      name: 'ACP runtime (starter)',
      protocolFamily: 'acp',
      commandName: HERMES_ACP_BIN,
      fixedArgs: [],
      enabled: true,
    },
    overrideAccess: true,
  })
  const agent = await payload.create({
    collection: 'agents',
    data: {
      workspace: workspace.id,
      name: 'Starter agent',
      runtimeProfile: runtimeProfile.id,
      thinkingLevel: 'medium',
      instructions: 'You are a helpful starter agent for a new workspace. Keep responses short and concrete.',
      permissionMode: 'ask',
      maxConcurrentRuns: 1,
      // Disabled by default — see this file's header comment for why a
      // seeded agent must not claim to be ready before a human has
      // confirmed HERMES_ACP_BIN actually resolves on this machine.
      enabled: false,
    },
    overrideAccess: true,
  })

  // 3. Task statuses (only if the workspace genuinely has none yet).
  const todoStatus = await ensureTaskStatuses(payload, workspace.id)

  // 4a. The sample database (D3/D4: `databases` + `database-rows`, never
  // the stock `affine:database` block).
  const database = await payload.create({
    collection: 'databases',
    data: {
      workspace: workspace.id,
      name: 'Sample tracker',
      fields: [
        { id: 'name', name: 'Name', type: 'singleLineText', isPrimary: true },
        { id: 'status', name: 'Status', type: 'singleSelect', options: { choices: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }] } },
      ],
    },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'database-rows',
    data: { database: database.id, cells: { name: 'First row', status: 'todo' }, position: 0 },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'database-rows',
    data: { database: database.id, cells: { name: 'Second row', status: 'done' }, position: 1 },
    overrideAccess: true,
  })

  // 5. The first task — created before the sample page so the page's task
  // block can reference a real taskId.
  const task = await payload.create({
    collection: 'tasks',
    data: {
      workspace: workspace.id,
      project: project.id,
      status: todoStatus.id,
      title: 'Try your first run',
      createdBy: user.id,
      agent: agent.id,
    },
    overrideAccess: true,
  })

  // 6. One real run for that task. Mirrors exactly what `updateTaskFields`
  // does server-side when a task's `agent` field is set for the first time
  // (see AGENTS.md's B-0 command-bar note) — status starts 'queued'.
  const run = await enqueueRun({
    taskId: task.id,
    agentId: agent.id,
    originatorUser: user.id,
    accountableUser: user.id,
    prompt: 'Say hello and summarize what you can help with in this workspace.',
  })

  // 4b. The sample page, built directly with BlockSuite's headless doc API
  // (same server-side setup `lib/blocksuite-doc.ts` uses for every other
  // page) — real task/database/run-card blocks, not screenshots or prose
  // describing them.
  const page = await payload.create({
    collection: 'pages',
    data: { title: 'Welcome', workspace: workspace.id },
    overrideAccess: true,
  })
  const { doc } = loadDoc(page.id, 'Welcome', null)
  const noteId = seedEmptyDoc(doc, 'Welcome')
  const addParagraph = (text: string) => doc.addBlock('affine:paragraph', { type: 'text', text: new Text(text) }, noteId)
  addParagraph('This page demonstrates the blocks agents and tasks can add to any document.')
  doc.addBlock('affine:embed-task', { taskId: task.id }, noteId)
  addParagraph('A database, backed by this workspace\'s own generic user-database engine (never the stock table block):')
  doc.addBlock('affine:embed-teable-native', { sourceType: 'user-database', userDatabaseId: database.id }, noteId)
  addParagraph("And the run this task's agent just queued:")
  doc.addBlock('affine:embed-run-card', { runId: run.id }, noteId)
  await payload.update({ collection: 'pages', id: page.id, data: { docState: { update: encodeDocUpdate(doc) } }, overrideAccess: true })
  await payload.update({ collection: 'tasks', id: task.id, data: { page: page.id }, overrideAccess: true })

  return { project, runtimeProfile, agent, todoStatus, database, task, run, page }
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

  const result = await seedStarterWorkspace({ workspaceSlug, userEmail })
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
