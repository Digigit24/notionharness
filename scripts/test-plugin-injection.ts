// R4.1/R4.2 verification — does a plugin row actually become an MCP server
// entry for the right agent, with a live credential substituted in?
//
// Creates two agents' worth of scoping against real rows, checks who gets
// what, and cleans up after itself.
//
//   npx tsx scripts/test-plugin-injection.ts
import { randomUUID } from 'node:crypto'

import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const { resolvePluginsForRun } = await import('../lib/plugins/resolve')

// Fixture names are unique per run. They used to be fixed strings, so a row
// left behind by an interrupted run (this script cleans up in `finally`, which
// a killed process never reaches) was indistinguishable from this run's own —
// and a stale `test-scoped` bound to a different agent failed the single most
// important assertion here for a reason that had nothing to do with the code.
const TAG = randomUUID().slice(0, 8)
const NAME = (base: string) => `test-${base}-${TAG}`

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const payload = await getPayloadClient()
// Pick the workspace that can actually exercise cross-agent scoping. Taking
// the first workspace silently skipped the most important assertion here --
// "another agent does NOT get this plugin" -- on a machine that had a
// perfectly good four-agent workspace one row further down.
const workspaces = (await payload.find({ collection: 'workspaces', limit: 50, depth: 0, overrideAccess: true })).docs
if (workspaces.length === 0) throw new Error('No workspace exists.')
let workspace = workspaces[0]
let agents: Array<{ id: number; name: string }> = []
for (const candidate of workspaces) {
  const found = (
    await payload.find({
      collection: 'agents',
      where: { workspace: { equals: candidate.id } },
      limit: 2,
      depth: 0,
      overrideAccess: true,
    })
  ).docs
  if (found.length > agents.length) {
    workspace = candidate
    agents = found
  }
  if (agents.length >= 2) break
}
if (agents.length < 1) throw new Error('No workspace has any agents.')
console.log(`workspace: ${workspace.name} (${agents.length} agent(s) available)`)

const targetAgent = agents[0]
const otherAgent = agents[1] ?? null
const created: number[] = []

try {
  const scoped = await payload.create({
    collection: 'plugins',
    data: {
      workspace: workspace.id,
      name: NAME('scoped'),
      transport: 'http',
      url: 'http://localhost:3000/api/mcp',
      headers: [
        { name: 'Authorization', value: 'Bearer {{RUN_TOKEN}}' },
        { name: 'X-Run-Id', value: '{{RUN_ID}}' },
      ],
      enabled: true,
      scope: 'agents',
      agents: [targetAgent.id],
      configOptions: [{ id: 'verbosity', label: 'Verbosity', type: 'select', value: 'high' }],
    },
    overrideAccess: true,
  })
  created.push(scoped.id)

  const everyone = await payload.create({
    collection: 'plugins',
    data: { workspace: workspace.id, name: NAME('workspace-wide'), transport: 'http', url: 'https://example.com/mcp', enabled: true, scope: 'workspace' },
    overrideAccess: true,
  })
  created.push(everyone.id)

  const disabled = await payload.create({
    collection: 'plugins',
    data: { workspace: workspace.id, name: NAME('disabled'), transport: 'http', url: 'https://example.com/mcp', enabled: false, scope: 'workspace' },
    overrideAccess: true,
  })
  created.push(disabled.id)

  const broken = await payload.create({
    collection: 'plugins',
    data: { workspace: workspace.id, name: NAME('no-url'), transport: 'http', enabled: true, scope: 'workspace' },
    overrideAccess: true,
  })
  created.push(broken.id)

  const resolved = await resolvePluginsForRun({
    workspaceId: workspace.id,
    agentId: targetAgent.id,
    substitutions: { RUN_TOKEN: 'secret-token-value', RUN_ID: '4242' },
  })
  const names = resolved.servers.map((s) => s.name)

  check('scoped plugin reaches its agent', names.includes(NAME('scoped')), names.join(', '))
  check('workspace-wide plugin reaches every agent', names.includes(NAME('workspace-wide')))
  check('disabled plugin is absent entirely', !names.includes(NAME('disabled')))
  check(
    'a plugin that cannot load is reported, not dropped',
    resolved.skipped.some((s) => s.name === NAME('no-url')),
    JSON.stringify(resolved.skipped),
  )

  const scopedServer = resolved.servers.find((s) => s.name === NAME('scoped'))
  const headers = scopedServer && 'headers' in scopedServer ? scopedServer.headers : []
  const auth = headers.find((h) => h.name === 'Authorization')?.value
  const runIdHeader = headers.find((h) => h.name === 'X-Run-Id')?.value
  check('run token is substituted into the header', auth === 'Bearer secret-token-value', String(auth))
  check('run id is substituted into the header', runIdHeader === '4242', String(runIdHeader))
  check(
    'transport is the ACP http variant',
    scopedServer !== undefined && 'type' in scopedServer && scopedServer.type === 'http',
  )
  check(
    'declared settings ride along as _meta',
    JSON.stringify(scopedServer?._meta) === JSON.stringify({ config: { verbosity: 'high' } }),
    JSON.stringify(scopedServer?._meta),
  )

  if (otherAgent) {
    const forOther = await resolvePluginsForRun({ workspaceId: workspace.id, agentId: otherAgent.id })
    const otherNames = forOther.servers.map((s) => s.name)
    check('another agent does NOT get the scoped plugin', !otherNames.includes(NAME('scoped')), otherNames.join(', '))
    check('another agent DOES get the workspace-wide one', otherNames.includes(NAME('workspace-wide')))
  } else {
    console.log('SKIP  scoping-against-another-agent (this workspace has only one agent)')
  }

  // A stored value with no placeholder must survive untouched, and an unknown
  // placeholder must stay visible rather than silently becoming empty.
  const literal = await payload.create({
    collection: 'plugins',
    data: {
      workspace: workspace.id,
      name: NAME('literal'),
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: [{ name: 'X-Fixed', value: 'plain-value' }, { name: 'X-Typo', value: '{{NOT_A_THING}}' }],
      enabled: true,
      scope: 'workspace',
    },
    overrideAccess: true,
  })
  created.push(literal.id)
  const again = await resolvePluginsForRun({ workspaceId: workspace.id, agentId: targetAgent.id, substitutions: { RUN_TOKEN: 'x' } })
  const literalServer = again.servers.find((s) => s.name === NAME('literal'))
  const literalHeaders = literalServer && 'headers' in literalServer ? literalServer.headers : []
  check('a literal header value is untouched', literalHeaders.find((h) => h.name === 'X-Fixed')?.value === 'plain-value')
  check(
    'an unknown placeholder stays visible rather than blanking',
    literalHeaders.find((h) => h.name === 'X-Typo')?.value === '{{NOT_A_THING}}',
    String(literalHeaders.find((h) => h.name === 'X-Typo')?.value),
  )
} finally {
  for (const id of created) {
    await payload.delete({ collection: 'plugins', id, overrideAccess: true }).catch(() => undefined)
  }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
