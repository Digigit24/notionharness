// What can this runtime actually be configured with?
//
// The ACP `initialize` handshake does NOT carry a model list — verified
// against the SDK's own schema, where `availableModels` does not appear at
// all. Model choice, where a runtime offers one, arrives as self-describing
// `configOptions` on the `session/new` response. So finding out costs a
// session, not just a handshake.
//
//   npx tsx scripts/probe-session-config.ts "claude-agent-acp"
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

const command = process.argv[2]
if (!command) throw new Error('Usage: npx tsx scripts/probe-session-config.ts "<command>"')

const isBatch = /\.(cmd|bat)$/i.test(command)
const child = isBatch
  ? spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', command], { stdio: 'pipe', windowsHide: true })
  : spawn(command, [], { stdio: 'pipe', windowsHide: true, shell: process.platform === 'win32' })

child.stderr.on('data', () => {})

const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>

const app = client({ name: 'notionforge-probe' })
  .onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' } }))
  .onNotification('session/update', async () => {})

const done = app.connectWith(ndJsonStream(writable, readable), async (ctx) => {
  const init = await ctx.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'notionforge-probe', version: '0.1.0' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  })
  console.log(`agent: ${init.agentInfo?.name ?? 'unknown'}`)
  console.log('')

  const session = (await ctx.request('session/new', { cwd: tmpdir(), mcpServers: [] })) as {
    sessionId: string
    modes?: unknown
    configOptions?: unknown
  }
  console.log(`sessionId: ${session.sessionId}`)
  console.log('')
  console.log('modes:')
  console.log(JSON.stringify(session.modes ?? null, null, 2))
  console.log('')
  console.log('configOptions:')
  console.log(JSON.stringify(session.configOptions ?? null, null, 2))
})

const timer = setTimeout(() => {
  console.error('timed out')
  child.kill()
  process.exit(1)
}, 45_000)

try {
  await done
} finally {
  clearTimeout(timer)
  child.kill()
}
process.exit(0)
