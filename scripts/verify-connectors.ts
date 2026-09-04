/**
 * What can actually be proven about connectors without a Composio key.
 *
 * There is no key on this machine, so the live OAuth round trip is NOT tested
 * here and this script does not pretend otherwise — it says so at the end. What
 * it does prove is the three things that would still be wrong if the key
 * existed and that no amount of clicking would reveal:
 *
 *   1. KEY RESOLUTION ORDER and the sentence when nothing is set. The order is
 *      the whole BYO-key argument (a workspace with its own key must never
 *      silently spend the server's shared budget), and the failure message is
 *      the only thing an admin has to go on.
 *   2. THE KEY NEVER APPEARS in anything a caller can reach — not in the
 *      presence object, not in a thrown failure, not in a JSON serialisation of
 *      either.
 *   3. SCOPE RESOLUTION: the union across workspace/project/agent, and the two
 *      intersections (the accountable user's own live connections, and
 *      `effectiveAgentAccess`).
 *
 * Run: npx tsx --conditions=react-server --env-file=.env scripts/verify-connectors.ts
 *
 * The `--conditions=react-server` is not optional. `lib/connectors/*` all start
 * with `import 'server-only'`, whose package resolves to a module that throws
 * outside a server component; that condition is how Next itself selects the
 * harmless entry point, and without it this script dies before its first
 * assertion with an error about client components that has nothing to do with
 * connectors.
 */
import assert from 'node:assert/strict'
import { describeKey, composioUserId } from '../lib/connectors/composio'
import {
  connectorsInScope,
  withUserConnections,
  allowsConnectorUse,
  type ScopedConnector,
  type ScopedConnection,
} from '../lib/connectors/scope'
import { effectiveAgentRole, grantRoleAllows } from '../lib/permissions/model'
import { isFailureEnvelope, toFailureInfo } from '../lib/failures'
import { getPayloadClient } from '../lib/payload'
import { closeBrokerPool } from '../lib/broker/db'

let failures = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => {
      failures += 1
      console.log(`  FAIL ${name}`)
      console.log(`       ${err instanceof Error ? err.message : String(err)}`)
    })
}

/* ------------------------------------------------------------------ */
/* 1 + 2. Key resolution and non-disclosure                            */
/* ------------------------------------------------------------------ */

async function keyTests() {
  console.log('\nKey resolution')

  const payload = await getPayloadClient()
  const workspaces = await payload.find({ collection: 'workspaces', limit: 1, depth: 0, overrideAccess: true })
  const workspace = workspaces.docs[0]
  if (!workspace) {
    console.log('  SKIP no workspace in this database')
    return
  }

  // The sentinel is written to the DATABASE and then read back through the one
  // module allowed to read it, because that is the path a real request takes.
  // Asserting against an in-memory value would prove nothing about the
  // `read: () => false` field access that this module deliberately overrides.
  const SENTINEL = 'comp_sentinel_do_not_log_0123456789'
  const originalKey = (workspace as { composioApiKey?: string | null }).composioApiKey ?? null
  const originalEnv = process.env.COMPOSIO_API_KEY

  try {
    // (a) Nothing set anywhere → the failure names both remedies.
    await payload.update({ collection: 'workspaces', id: workspace.id, data: { composioApiKey: null }, overrideAccess: true })
    delete process.env.COMPOSIO_API_KEY

    await check('with no key anywhere, describeKey reports absence rather than throwing', async () => {
      const presence = await describeKey(workspace.id)
      assert.equal(presence.present, false)
      assert.equal(presence.source, null)
      assert.equal(presence.length, 0)
    })

    await check('the missing-key failure names BOTH the settings screen and the env var', async () => {
      // Reached through a real caller rather than by calling the private
      // resolver: what matters is the sentence a person actually sees.
      const { listToolkits } = await import('../lib/connectors/composio')
      let message = ''
      try {
        await listToolkits(workspace.id)
      } catch (err) {
        message = toFailureInfo(err).message
      }
      assert.ok(message.includes('Settings'), `expected the settings screen to be named; got: ${message}`)
      assert.ok(message.includes('COMPOSIO_API_KEY'), `expected the env var to be named; got: ${message}`)
    })

    // (b) Environment only → source is `environment`.
    process.env.COMPOSIO_API_KEY = 'env_key_1234567890abcdef'
    await check('with only COMPOSIO_API_KEY set, the source is the environment', async () => {
      const presence = await describeKey(workspace.id)
      assert.equal(presence.present, true)
      assert.equal(presence.source, 'environment')
      assert.equal(presence.length, 'env_key_1234567890abcdef'.length)
    })

    // (c) Both set → the WORKSPACE key wins. This is the BYO-key rule and it is
    // the one assertion here that protects a customer's Composio budget.
    await payload.update({
      collection: 'workspaces',
      id: workspace.id,
      data: { composioApiKey: SENTINEL },
      overrideAccess: true,
    })
    await check('a workspace key beats COMPOSIO_API_KEY rather than falling through to it', async () => {
      const presence = await describeKey(workspace.id)
      assert.equal(presence.source, 'workspace')
      assert.equal(presence.length, SENTINEL.length, 'the length reported is the WORKSPACE key’s, not the environment’s')
    })

    await check('the key value appears nowhere in what a caller can reach', async () => {
      const presence = await describeKey(workspace.id)
      const serialised = JSON.stringify(presence)
      assert.ok(!serialised.includes(SENTINEL), 'the presence object leaked the key')
      assert.ok(!serialised.includes(SENTINEL.slice(0, 8)), 'the presence object leaked a prefix of the key')

      // And in a failure raised while the key IS set: a request that fails must
      // not carry the credential it was sent with. Pointed at an unroutable
      // host by no means available here, so this exercises the transport error
      // path rather than a Composio response.
      const { listToolkits } = await import('../lib/connectors/composio')
      let thrown: unknown = null
      try {
        await listToolkits(workspace.id, { search: 'gmail' })
      } catch (err) {
        thrown = err
      }
      if (thrown) {
        const info = toFailureInfo(thrown)
        const text = JSON.stringify(info) + String((thrown as Error)?.stack ?? '')
        assert.ok(!text.includes(SENTINEL), 'a thrown failure carried the key')
      }
    })

    await check('the Composio entity id is derived from our user, prefixed, and is never an email', () => {
      assert.equal(composioUserId(41), 'nf_user_41')
      assert.notEqual(composioUserId(41), '41')
      assert.ok(!composioUserId(41).includes('@'))
    })
  } finally {
    // Always put the workspace back. A sentinel key left in the database would
    // break every connector screen on this install.
    await payload.update({
      collection: 'workspaces',
      id: workspace.id,
      data: { composioApiKey: originalKey },
      overrideAccess: true,
    })
    if (originalEnv === undefined) delete process.env.COMPOSIO_API_KEY
    else process.env.COMPOSIO_API_KEY = originalEnv
  }
}

/* ------------------------------------------------------------------ */
/* 3. Scope: the union and the two intersections                       */
/* ------------------------------------------------------------------ */

const AGENT_ID = 7
const PROJECT_ID = 12
const OTHER_PROJECT_ID = 99
const OTHER_AGENT_ID = 8

const connector = (over: Partial<ScopedConnector> & Pick<ScopedConnector, 'id' | 'toolkitSlug' | 'scopeType'>): ScopedConnector => ({
  name: over.toolkitSlug,
  scopeId: null,
  enabled: true,
  allowedTools: [],
  ...over,
})

const FIXTURES: ScopedConnector[] = [
  connector({ id: 1, toolkitSlug: 'gmail', scopeType: 'workspace' }),
  connector({ id: 2, toolkitSlug: 'linear', scopeType: 'project', scopeId: String(PROJECT_ID) }),
  connector({ id: 3, toolkitSlug: 'github', scopeType: 'agent', scopeId: String(AGENT_ID) }),
  // Attached elsewhere. Present in the same workspace, and must NOT appear.
  connector({ id: 4, toolkitSlug: 'notion', scopeType: 'project', scopeId: String(OTHER_PROJECT_ID) }),
  connector({ id: 5, toolkitSlug: 'slack', scopeType: 'agent', scopeId: String(OTHER_AGENT_ID) }),
  // Switched off by an admin.
  connector({ id: 6, toolkitSlug: 'jira', scopeType: 'workspace', enabled: false }),
]

function scopeTests() {
  console.log('\nScope resolution — the union')

  void check('the union is workspace ∪ project ∪ agent, and nothing else', () => {
    const got = connectorsInScope(FIXTURES, { agentId: AGENT_ID, projectId: PROJECT_ID })
      .map((row) => row.toolkitSlug)
      .sort()
    assert.deepEqual(got, ['github', 'gmail', 'linear'])
  })

  void check('an agent-scoped connector ADDS to the workspace’s rather than replacing them', () => {
    // The precedence bug this rules out: if `scopeType: 'agent'` won, `gmail`
    // would disappear the moment `github` was granted to this agent.
    const got = connectorsInScope(FIXTURES, { agentId: AGENT_ID, projectId: PROJECT_ID }).map((r) => r.toolkitSlug)
    assert.ok(got.includes('gmail'), 'the workspace-level connector was lost when an agent-level one existed')
    assert.ok(got.includes('github'))
  })

  void check('a run with no project sees no project-scoped connectors and is not an error', () => {
    const got = connectorsInScope(FIXTURES, { agentId: AGENT_ID, projectId: null }).map((r) => r.toolkitSlug).sort()
    assert.deepEqual(got, ['github', 'gmail'])
  })

  void check('another project’s and another agent’s connectors never appear', () => {
    const got = connectorsInScope(FIXTURES, { agentId: AGENT_ID, projectId: PROJECT_ID }).map((r) => r.toolkitSlug)
    assert.ok(!got.includes('notion'))
    assert.ok(!got.includes('slack'))
  })

  void check('a disabled connector is dropped by the union step itself', () => {
    const got = connectorsInScope(FIXTURES, { agentId: AGENT_ID, projectId: PROJECT_ID }).map((r) => r.toolkitSlug)
    assert.ok(!got.includes('jira'))
  })

  console.log('\nScope resolution — intersection with the accountable user’s connections')

  const connections: ScopedConnection[] = [
    { toolkitSlug: 'gmail', status: 'active' },
    { toolkitSlug: 'linear', status: 'pending' },
    // No row at all for `github`.
  ]

  void check('only an ACTIVE connection makes a connector usable', () => {
    const resolved = withUserConnections(connectorsInScope(FIXTURES, { agentId: AGENT_ID, projectId: PROJECT_ID }), connections)
    const usable = resolved.filter((r) => r.usable).map((r) => r.connector.toolkitSlug)
    assert.deepEqual(usable, ['gmail'])
  })

  void check('the three not-usable cases are told apart, because they need different sentences', () => {
    const resolved = withUserConnections(connectorsInScope(FIXTURES, { agentId: AGENT_ID, projectId: PROJECT_ID }), connections)
    const reasons = Object.fromEntries(resolved.map((r) => [r.connector.toolkitSlug, r.reason]))
    assert.equal(reasons.gmail, null)
    assert.equal(reasons.linear, 'connection_pending')
    assert.equal(reasons.github, 'not_connected')
  })

  void check('an active row wins over a stale one for the same toolkit, whatever the row order', () => {
    const messy: ScopedConnection[] = [
      { toolkitSlug: 'gmail', status: 'failed' },
      { toolkitSlug: 'gmail', status: 'active' },
    ]
    const reversed = [...messy].reverse()
    for (const rows of [messy, reversed]) {
      const [entry] = withUserConnections([FIXTURES[0]], rows)
      assert.equal(entry.usable, true, 'row order changed the answer')
    }
  })

  void check('toolkit matching is case-insensitive on both sides', () => {
    const [entry] = withUserConnections([connector({ id: 9, toolkitSlug: 'GMail', scopeType: 'workspace' })], [
      { toolkitSlug: 'gmail', status: 'active' },
    ])
    assert.equal(entry.usable, true)
  })

  console.log('\nScope resolution — intersection with effectiveAgentAccess')

  void check('`execute` is the verb, so a viewer-level effective role cannot use a connector', () => {
    assert.equal(allowsConnectorUse('viewer'), false)
    assert.equal(allowsConnectorUse('editor'), true)
    assert.equal(allowsConnectorUse('admin'), true)
    assert.equal(allowsConnectorUse(null), false)
  })

  void check('an admin agent acting for a VIEWER gets viewer, and therefore cannot use a connector', () => {
    // The escalation the intersection rule exists to close: without it, "give
    // the agent Slack" would let a viewer trigger a run that posts as an admin.
    const effective = effectiveAgentRole('admin', 'viewer')
    assert.equal(effective, 'viewer')
    assert.equal(allowsConnectorUse(effective), false)
  })

  void check('an agent with no grant gets nothing even when the person is an owner', () => {
    const effective = effectiveAgentRole(null, 'admin')
    assert.equal(effective, null)
    assert.equal(allowsConnectorUse(effective), false)
  })

  void check('a viewer agent acting for an owner is still a viewer — the weaker side always wins', () => {
    assert.equal(effectiveAgentRole('viewer', 'admin'), 'viewer')
    assert.equal(effectiveAgentRole('admin', 'editor'), 'editor')
    assert.equal(effectiveAgentRole('editor', 'admin'), 'editor')
  })

  void check('`execute` and `write` are genuinely separate, so the check above is not vacuous', () => {
    assert.equal(grantRoleAllows('viewer', 'read'), true)
    assert.equal(grantRoleAllows('viewer', 'execute'), false)
  })
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('Connectors — what can be proven without a Composio key')
  scopeTests()
  await keyTests()

  console.log('\nNOT VERIFIED HERE, and not claimed:')
  console.log('  · the live OAuth round trip (link → consent → callback → active).')
  console.log('    There is no Composio key on this machine and no account to authorise against.')
  console.log('  · Composio’s response shapes against a real 200. They were transcribed from')
  console.log('    backend.composio.dev/api/v3/openapi.json, fetched 2026-09-04, not from a live call.')
  console.log('  · whether a connection-completed webhook exists. The poll exists because it does not.')

  console.log(failures === 0 ? '\nAll assertions passed.' : `\n${failures} assertion(s) FAILED.`)
  await closeBrokerPool()
  process.exit(failures === 0 ? 0 : 1)
}

// `isFailureEnvelope` is imported for the type-level guarantee that this script
// and the actions agree on the envelope shape; referenced so lint sees the use.
void isFailureEnvelope

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
