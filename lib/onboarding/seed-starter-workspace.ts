// Phase C, C4 — "seed the empty workspace... wire it into first-run." The
// actual seeding logic (project, runtime profile, agent, task, run, sample
// page) was written for `scripts/seed-starter-workspace.ts` back in B-6 but
// never executed and never reachable from the app — extracted here so it's
// safely importable from a live server action.
//
// This split exists for a real, structural reason, not just tidiness:
// `scripts/seed-starter-workspace.ts`'s own file calls its CLI `main()`
// unconditionally at module load (matching every other script in that
// directory's stated convention — see that file's own comment — "always
// invoked directly via tsx, never imported as a module elsewhere") and,
// in its `.finally()`, closes the shared broker pool. Importing that file
// directly from the live app would run its CLI arg-parsing against the
// Next.js process's own `process.argv` (harmless — no matching flags, so
// it dry-run-prints and returns) but would ALSO eagerly close the app's
// live `lib/broker` connection pool the instant the module loaded,
// breaking every other broker-dependent feature for the rest of that
// server's lifetime. This module has no top-level side effects at all —
// safe to import from anywhere, including a live request path.
import { getPayloadClient } from '@/lib/payload'
import { enqueueRun } from '@/lib/broker'
import { loadDoc, seedEmptyDoc, encodeDocUpdate } from '@/lib/blocksuite-doc'
import { Text } from '@/lib/blocksuite-store'
import type { Payload } from 'payload'
import type { RuntimeProfile, TaskStatus } from '@/payload-types'
import { RUNTIME_CATALOG, catalogEntryCommandLine, catalogEntryForCommand } from '@/lib/runtimes/catalog'
import { resolveCommandPath } from '@/lib/runtimes/spawn-command'

// Unlike the standalone script (which needs `nextEnv.loadEnvConfig()` and a
// hard failure if unset, since it has no other way to get env vars), the
// live app already has env loaded — and the seeded agent starts `enabled:
// false` regardless (see below), so an unresolved binary path here is only
// ever a placeholder a human confirms before turning the agent on, never a
// value anything actually spawns against from this code path.
/**
 * The runtime the starter profile points at.
 *
 * An explicit `ACP_RUNTIME_COMMAND` wins, whatever it names — and since it
 * names a CLI we may not know, it gets no home strategy beyond what the
 * catalog can infer from the command. Otherwise the Hermes-specific
 * variables, for installs that predate the catalog. Otherwise the first
 * catalog CLI actually on this machine's PATH, in catalog order, so a machine
 * with only Codex on it seeds a Codex profile rather than a Hermes one that
 * can never probe green. Otherwise Hermes by name, which is what this always
 * did, and which the disabled starter agent keeps safe (see below).
 */
async function pickStarterRuntime(): Promise<{ name: string; commandName: string; fixedArgs: string[]; homeStrategy: string }> {
  if (process.env.ACP_RUNTIME_COMMAND) {
    const command = process.env.ACP_RUNTIME_COMMAND
    const known = catalogEntryForCommand(command)
    return {
      name: known ? `${known.displayName} (starter)` : 'ACP runtime (starter)',
      commandName: command,
      fixedArgs: [],
      homeStrategy: known?.homeStrategy ?? 'none',
    }
  }
  const hermesBinary =
    process.env.HERMES_ACP_BIN ??
    (process.env.HERMES_HOME_BASE
      ? `${process.env.HERMES_HOME_BASE}\\hermes-agent\\venv\\Scripts\\hermes-acp.exe`
      : undefined)
  if (hermesBinary) {
    return { name: 'Hermes Agent (starter)', commandName: hermesBinary, fixedArgs: [], homeStrategy: 'hermes' }
  }
  for (const entry of RUNTIME_CATALOG) {
    if (await resolveCommandPath(entry.detectCommand)) {
      return {
        name: `${entry.displayName} (starter)`,
        commandName: catalogEntryCommandLine(entry),
        fixedArgs: [],
        homeStrategy: entry.homeStrategy,
      }
    }
  }
  return { name: 'ACP runtime (starter)', commandName: 'hermes-acp', fixedArgs: [], homeStrategy: 'hermes' }
}

export interface SeedStarterWorkspaceOptions {
  workspaceId: number
  userId: number
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
    const all = await payload.find({
      collection: 'task-statuses',
      where: { workspace: { equals: workspaceId } },
      limit: 20,
      overrideAccess: true,
    })
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

/**
 * Same content this workspace's own `scripts/seed-starter-workspace.ts`
 * documents in full (that file's header comment is the source of truth for
 * the *what* and *why* of each step) — a starter project, a disabled
 * starter agent + runtime profile, default task statuses if none exist, a
 * sample database, a first task, one real (queued) run, and a "Welcome"
 * page demonstrating the task/database/run-card blocks. NOT fully
 * idempotent, same as the script: calling this twice on the same workspace
 * creates a second "Getting Started" project, a second sample page, etc.
 */
export async function seedStarterWorkspace({ workspaceId, userId }: SeedStarterWorkspaceOptions) {
  const payload = await getPayloadClient()
  const starterRuntime = await pickStarterRuntime()

  // 1. Starter project.
  const project = await payload.create({
    collection: 'projects',
    data: {
      workspace: workspaceId,
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
      workspace: workspaceId,
      name: starterRuntime.name,
      protocolFamily: 'acp',
      commandName: starterRuntime.commandName,
      fixedArgs: starterRuntime.fixedArgs,
      homeStrategy: starterRuntime.homeStrategy as RuntimeProfile['homeStrategy'],
      enabled: true,
    },
    overrideAccess: true,
  })
  const agent = await payload.create({
    collection: 'agents',
    data: {
      workspace: workspaceId,
      name: 'Starter agent',
      runtimeProfile: runtimeProfile.id,
      thinkingLevel: 'medium',
      instructions: 'You are a helpful starter agent for a new workspace. Keep responses short and concrete.',
      permissionMode: 'ask',
      maxConcurrentRuns: 1,
      // Disabled by default — a seeded agent pointed at a binary path that
      // may not exist on this machine must not silently look "ready"
      // before a human confirms it. FirstRunChecklist's "connect a
      // provider" step treats an enabled runtime profile as the real
      // signal, and a disabled one (this one) does not count as done.
      enabled: false,
    },
    overrideAccess: true,
  })

  // 3. Task statuses (only if the workspace genuinely has none yet).
  const todoStatus = await ensureTaskStatuses(payload, workspaceId)

  // 4a. The sample database (`databases` + `database-rows` — this
  // workspace's own generic user-database engine, never the stock
  // `affine:database` block).
  const database = await payload.create({
    collection: 'databases',
    data: {
      workspace: workspaceId,
      name: 'Sample tracker',
      // `text`/`select` — BlockSuite's own native field-type vocabulary
      // (`components/editor/blocks/data-sources/user-database-data-
      // source.ts`), confirmed live this session, NOT to be confused with
      // the similarly-named but different Teable vocabulary
      // (`singleLineText`/`singleSelect`) `teable-data-source.ts` uses for
      // its own, unrelated sync path — using the Teable names here threw
      // `Unknown property type` at render time, a real bug this session
      // caught by actually opening the seeded page in a browser rather
      // than trusting the create call succeeding.
      fields: [
        { id: 'name', name: 'Name', type: 'text', isPrimary: true },
        {
          id: 'status',
          name: 'Status',
          type: 'select',
          options: { choices: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }] },
        },
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
      workspace: workspaceId,
      project: project.id,
      status: todoStatus.id,
      title: 'Try your first run',
      createdBy: userId,
      agent: agent.id,
    },
    overrideAccess: true,
  })

  // 6. One real run for that task. Mirrors exactly what `updateTaskFields`
  // does server-side when a task's `agent` field is set for the first
  // time — status starts 'queued'; it only actually executes once a real
  // dispatcher loop and a working `HERMES_ACP_BIN` are both present.
  const run = await enqueueRun({
    taskId: task.id,
    agentId: agent.id,
    originatorUser: userId,
    accountableUser: userId,
    prompt: 'Say hello and summarize what you can help with in this workspace.',
  })

  // 4b. The sample page, built directly with BlockSuite's headless doc API
  // (same server-side setup `lib/blocksuite-doc.ts` uses for every other
  // page) — real task/database/run-card blocks, not screenshots or prose
  // describing them.
  const page = await payload.create({
    collection: 'pages',
    data: { title: 'Welcome', workspace: workspaceId },
    overrideAccess: true,
  })
  const { doc } = loadDoc(page.id, 'Welcome', null)
  const noteId = seedEmptyDoc(doc, 'Welcome')
  const addParagraph = (text: string) => doc.addBlock('affine:paragraph', { type: 'text', text: new Text(text) }, noteId)
  addParagraph('This page demonstrates the blocks agents and tasks can add to any document.')
  doc.addBlock('affine:embed-task', { taskId: task.id }, noteId)
  addParagraph("A database, backed by this workspace's own generic user-database engine (never the stock table block):")
  doc.addBlock('affine:embed-teable-native', { sourceType: 'user-database', userDatabaseId: database.id }, noteId)
  addParagraph("And the run this task's agent just queued:")
  doc.addBlock('affine:embed-run-card', { runId: run.id }, noteId)
  await payload.update({ collection: 'pages', id: page.id, data: { docState: { update: encodeDocUpdate(doc) } }, overrideAccess: true })
  await payload.update({ collection: 'tasks', id: task.id, data: { page: page.id }, overrideAccess: true })

  return { project, runtimeProfile, agent, todoStatus, database, task, run, page }
}
