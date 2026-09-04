// R4.6 verification — does our HTTP MCP endpoint actually speak MCP, and does
// it refuse everyone it should?
//
// Creates one synthetic `running` run to authorise against, exercises the
// endpoint, and deletes the run again. The run is never dispatched (it has no
// agent) so the dispatcher will not pick it up mid-test.
//
//   npx tsx scripts/test-mcp-endpoint.ts [baseUrl]
import { randomUUID } from 'node:crypto'

import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const BASE = (process.argv[2] ?? process.env.NOTIONFORGE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const ENDPOINT = `${BASE}/api/mcp`

const { Pool } = await import('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** One MCP call over Streamable HTTP. The client must accept both content
 * types; the transport picks which it returns. */
async function rpc(method: string, params: unknown, headers: Record<string, string>) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await response.text()
  // A Streamable HTTP response may be SSE framing around the JSON body.
  const line = text
    .split(String.fromCharCode(10))
    .find((l) => l.startsWith('data: '))
  const raw = line ? line.slice(6) : text
  let body: unknown = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = raw
  }
  return { status: response.status, body, raw: text, contentType: response.headers.get('content-type') }
}

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'notionforge-test', version: '1.0.0' },
}

let runId: number | null = null
try {
  const token = randomUUID()
  const user = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
  if (user.rows.length === 0) throw new Error('No users exist; cannot create a test run.')
  const created = await pool.query<{ id: string }>(
    `INSERT INTO runs (status, accountable_user, run_token) VALUES ('running', $1, $2) RETURNING id`,
    [user.rows[0].id, token],
  )
  runId = Number(created.rows[0].id)
  console.log(`test run: ${runId}`)
  console.log(`endpoint: ${ENDPOINT}`)
  console.log('')

  // 1. No credentials at all.
  const anon = await rpc('initialize', INIT_PARAMS, {})
  check('rejects a request with no token', anon.status === 401, `status ${anon.status}`)

  // 2. A well-formed token that belongs to nobody.
  const bogus = await rpc('initialize', INIT_PARAMS, {
    Authorization: `Bearer ${randomUUID()}`,
    'X-Run-Id': String(runId),
  })
  check('rejects a token that is not this run\'s', bogus.status === 401, `status ${bogus.status}`)

  // 3. The real token, but naming a different run — the attack the
  //    token-vs-run-id comparison exists to stop.
  const mismatched = await rpc('initialize', INIT_PARAMS, {
    Authorization: `Bearer ${token}`,
    'X-Run-Id': String(runId + 999_999),
  })
  check('rejects a valid token pointed at another run', mismatched.status === 401, `status ${mismatched.status}`)

  // 4. The real thing.
  const auth = { Authorization: `Bearer ${token}`, 'X-Run-Id': String(runId) }
  const init = await rpc('initialize', INIT_PARAMS, auth)
  const initBody = init.body as { result?: { serverInfo?: { name?: string } } }
  check('initialize succeeds', init.status === 200, `status ${init.status}`)
  if (!initBody?.result) {
    console.log(`      content-type: ${init.contentType}`)
    console.log(`      raw: ${JSON.stringify(init.raw).slice(0, 500)}`)
  }
  check(
    'identifies itself as notionforge',
    initBody?.result?.serverInfo?.name === 'notionforge',
    JSON.stringify(initBody?.result?.serverInfo ?? init.body).slice(0, 160),
  )

  const list = await rpc('tools/list', {}, auth)
  const tools = (list.body as { result?: { tools?: Array<{ name: string }> } })?.result?.tools ?? []
  const names = tools.map((t) => t.name).sort()
  check('advertises its tools', names.length > 0, names.join(', ') || JSON.stringify(list.body).slice(0, 200))
  check('exposes get_page', names.includes('get_page'))
  check('exposes append_block', names.includes('append_block'))

  // 5. A settled run must not keep writing.
  await pool.query(`UPDATE runs SET status = 'completed' WHERE id = $1`, [runId])
  const settled = await rpc('initialize', INIT_PARAMS, auth)
  check('refuses a run that has already finished', settled.status === 409, `status ${settled.status}`)
} finally {
  if (runId !== null) await pool.query('DELETE FROM runs WHERE id = $1', [runId]).catch(() => undefined)
  await pool.end()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
