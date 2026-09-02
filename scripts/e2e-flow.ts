// P5.4 LIVE E2E — human-in-the-loop approval flow.
//
// Goal: prove the full dispatch -> Hermes ACP -> agent asks permission ->
// approvals row -> Inbox wiring -> POST /api/approvals resolves -> run
// resumes path. Raw pg + plain HTTP, no Payload client loaded here, per
// AGENTS.md "verify through the already-running container's client".
//
// Stages:
//   A. Sign up fresh Better-Auth user (gives us a session cookie via Set-Cookie).
//   B. Flip the only enabled agent to permission_mode='ask'.
//   C. Enqueue a run via raw SQL matching broker.run insert shape.
//   D. Drive POST /api/dispatcher/tick in a loop and watch for a row in
//      `approvals` to appear (status='pending').
//   E. Resolve via real POST /api/approvals with the session cookie.
//   F. Drive ticks again and confirm run status moved.
//
// Each step prints what was observed (status, timings, returned bodies).
// Any failure throws with a precise step label.

import nextEnv from '@next/env'
import { Pool } from 'pg'
import * as http from 'node:http'

nextEnv.loadEnvConfig(process.cwd())

const BASE = 'http://localhost:3000'
const ORIGIN = BASE
const EMAIL = `e2e-${Date.now()}@notionforge.test`
const PASSWORD = 'E2e-test-Password!1'
const NAME = 'E2E Aion CLI'

function http_(method: string, path: string, body?: any, cookie?: string, headers: Record<string, string> = {}): Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE)
    const opts: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'origin': ORIGIN,
        'content-type': 'application/json',
        'accept': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
    }
    const req = http.request(opts, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function extractCookie(headers: http.IncomingHttpHeaders): string {
  const sc = headers['set-cookie']
  if (!sc) return ''
  const arr = Array.isArray(sc) ? sc : [sc]
  return arr.map(c => c.split(';')[0]).join('; ')
}

async function waitFor<T>(fn: () => Promise<T | null>, ms: number, label: string): Promise<T> {
  const start = Date.now()
  let last: any = null
  while (Date.now() - start < ms) {
    last = await fn()
    if (last) return last as T
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`timeout waiting for ${label} after ${ms}ms; last=${JSON.stringify(last)}`)
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 2 })
  try {
    // ============== A. Sign up ==============
    console.log('--- Step A: sign up new Better Auth user')
    const signUpRes = await http_('POST', '/api/auth/sign-up/email', {
      email: EMAIL, password: PASSWORD, name: NAME,
    })
    console.log(`sign-up status=${signUpRes.status} body=${signUpRes.body.slice(0, 200)}`)
    if (signUpRes.status !== 200) throw new Error(`sign-up failed: ${signUpRes.status} ${signUpRes.body}`)
    const cookie = extractCookie(signUpRes.headers)
    console.log(`cookie: ${cookie ? cookie.slice(0, 80) + '...' : 'NONE'}`)
    if (!cookie) throw new Error('no cookie returned from sign-up')

    // Verify session via better-auth
    const sessRes = await http_('GET', '/api/auth/get-session', undefined, cookie)
    console.log(`get-session status=${sessRes.status} body=${sessRes.body.slice(0, 200)}`)

    // Also POST to a payload route to force lazy provisioning of the Payload shadow user
    const wsRes = await http_('GET', '/api/workspaces', undefined, cookie)
    console.log(`workspaces status=${wsRes.status} body=${wsRes.body.slice(0, 300)}`)

    // Give getCurrentPayloadUser() a chance to run via a real route
    const inboxRes = await http_('GET', '/api/approvals', undefined, cookie)
    console.log(`get /api/approvals status=${inboxRes.status} body=${inboxRes.body.slice(0, 200)}`)

    // ============== B. Flip agent 2 to 'ask' ==============
    console.log('\n--- Step B: flip agent 2 to permission_mode=ask')
    {
      const up = await pool.query(
        `UPDATE agents SET permission_mode='ask' WHERE id=2 RETURNING id, name, permission_mode`
      )
      console.log(`update result: ${JSON.stringify(up.rows)}`)
      if (!up.rowCount) throw new Error('no agent updated')
    }

    // ============== C. Enqueue run via raw SQL ==============
    console.log('\n--- Step C: enqueue run via raw SQL')
    // We match the broker's insert contract from lib/broker/runs.ts.
    // The columns are: status, attempt, max_attempts, priority, task_id, agent_id,
    // accountable_user, originator_user, prompt.
    const prompt = 'Please read /etc/hostname using shell and tell me what you see.'
    let runId: string
    {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO runs (status, attempt, max_attempts, priority, task_id, agent_id, accountable_user, prompt, created_at, updated_at)
         VALUES ('queued', 1, 3, 5, 13, 2, 1, $1, NOW(), NOW())
         RETURNING id`,
        [prompt]
      )
      runId = ins.rows[0]!.id
      console.log(`enqueued run id=${runId} prompt=${prompt.slice(0, 80)}`)
    }

    // ============== D. Tick + watch approvals ==============
    console.log('\n--- Step D: drive ticks until approval row appears')
    type ApprRow = { id: number; external_id: string; run_id: string; status: string; requested_user_id: number; title: string; created_at: string; updated_at: string }
    let apprRow: ApprRow | null = null
    let tickCount = 0
    const tStart = Date.now()
    while (Date.now() - tStart < 90_000) {
      tickCount++
      const t0 = Date.now()
      const tick = await http_('POST', '/api/dispatcher/tick', undefined, undefined)
      const tDur = Date.now() - t0
      const tickBody = tick.body.slice(0, 300)
      const found = await pool.query<ApprRow>(
        `SELECT id, external_id, run_id::text AS run_id, status, requested_user_id, title, created_at, updated_at
         FROM approvals WHERE run_id::int = $1 ORDER BY id DESC LIMIT 1`,
        [parseInt(runId, 10)]
      )
      if (found.rowCount && found.rows[0]!.status === 'pending') {
        apprRow = found.rows[0]!
        console.log(`  tick=${tickCount} (${tDur}ms) saw approval row pending: ${JSON.stringify(apprRow)}`)
        break
      }
      console.log(`  tick=${tickCount} ${tick.status} (${tDur}ms) body=${tickBody}`)
      if (found.rowCount) console.log(`  approvals row exists: ${JSON.stringify(found.rows[0])}`)
      await new Promise(r => setTimeout(r, 1500))
    }
    if (!apprRow) {
      // Dump what we DO have so we can debug
      const lastRun = await pool.query(`SELECT id, status, attempt, error, updated_at FROM runs WHERE id::int=$1`, [parseInt(runId, 10)])
      const allAppr = await pool.query(`SELECT id, run_id::text AS run_id, status, title, created_at, updated_at FROM approvals ORDER BY id DESC LIMIT 5`)
      const allR = await pool.query(`SELECT id, status, error, updated_at FROM runs ORDER BY updated_at DESC LIMIT 5`)
      console.error(`TIMEOUT: no pending approvals row after 90s of ticking`)
      console.error(`run state: ${JSON.stringify(lastRun.rows, null, 2)}`)
      console.error(`approvals: ${JSON.stringify(allAppr.rows, null, 2)}`)
      console.error(`all runs: ${JSON.stringify(allR.rows, null, 2)}`)
      throw new Error('did not see pending approvals row in 90s')
    }

    // ============== E. Resolve ==============
    console.log('\n--- Step E: POST /api/approvals to resolve')
    const resolveBody = { id: apprRow.id, decision: 'approve', selectedOptionId: null }
    const rres = await http_('POST', '/api/approvals', resolveBody, cookie)
    console.log(`resolve status=${rres.status} body=${rres.body}`)
    if (rres.status !== 200) throw new Error(`resolve failed: ${rres.body}`)

    // ============== F. Tick more + check run status ==============
    console.log('\n--- Step F: tick more + confirm run progressed')
    const tStart2 = Date.now()
    let lastRunState: any = null
    while (Date.now() - tStart2 < 60_000) {
      const tick = await http_('POST', '/api/dispatcher/tick', undefined, undefined)
      console.log(`  followup tick status=${tick.status} body=${tick.body.slice(0, 200)}`)
      const r = await pool.query(
        `SELECT id, status, attempt, error, updated_at, completed_at FROM runs WHERE id::int=$1`,
        [parseInt(runId, 10)]
      )
      lastRunState = r.rows[0] ?? lastRunState
      const a = await pool.query(
        `SELECT id, status, selected_option_id, updated_at FROM approvals WHERE id=$1`,
        [apprRow.id]
      )
      console.log(`  run=${JSON.stringify(r.rows[0])} approval=${JSON.stringify(a.rows[0])}`)
      if (lastRunState && ['completed','failed','cancelled'].includes(lastRunState.status)) break
      await new Promise(r => setTimeout(r, 3000))
    }
    console.log('\n=== summary ===')
    console.log(`agent2 permission_mode after run: ${(await pool.query('SELECT permission_mode FROM agents WHERE id=2')).rows[0]?.permission_mode}`)
    console.log(`final run state: ${JSON.stringify(lastRunState)}`)
    console.log(`final approval state: ${JSON.stringify((await pool.query('SELECT * FROM approvals WHERE id=$1', [apprRow.id])).rows[0])}`)

  } finally {
    await pool.end()
  }
}

main().then(() => process.exit(0)).catch(err => { console.error('FATAL:', err); process.exit(1) })
