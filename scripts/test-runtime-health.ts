// Does health report each runtime by a check that actually applies to it?
//
// Two bugs this guards, found one after the other:
//
// 1. Health ran the Hermes dashboard check for EVERY profile, so a working
//    Claude Code runtime was reported down with "Hermes responded 502" — a
//    status about a completely unrelated service.
// 2. Fixing only that left the same error one level up: with the dashboard
//    host returning 502, a Hermes runtime that demonstrably runs turns was
//    still reported "down". Reachability of a side service is not the same
//    question as whether the runtime works.
//
// So status means one thing for every runtime — can it start and complete a
// handshake, which is to say can it run a turn — and a dashboard, where one
// exists, is reported as its own separate fact.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const { refreshRuntimeForProfile } = await import('../lib/runtimes/hermes/runtime-health')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const payload = await getPayloadClient()
const profiles = await payload.find({
  collection: 'runtime-profiles',
  where: { enabled: { equals: true } },
  limit: 50,
  depth: 0,
  overrideAccess: true,
})

for (const profile of profiles.docs) {
  const strategy = (profile as { homeStrategy?: string | null }).homeStrategy ?? 'hermes'
  await refreshRuntimeForProfile(profile)
  const row = (
    await payload.find({
      collection: 'runtimes',
      where: { runtimeProfile: { equals: profile.id } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0]
  const info = (row?.connectionInfo ?? {}) as Record<string, unknown>
  const kind = String(info.checkKind ?? '')
  const dashboard = info.dashboard as { reachable?: boolean } | undefined

  console.log('')
  console.log(
    `${profile.name} (${strategy}) -> status=${row?.status} kind=${kind}` +
      (dashboard ? ` dashboard=${dashboard.reachable ? 'reachable' : 'unreachable'}` : ''),
  )

  check('  status comes from the protocol, not from a side service', kind === 'acp-handshake', kind)
  check(
    '  the host reported is the thing that was actually checked',
    String(row?.host ?? '') === profile.commandName,
    String(row?.host ?? ''),
  )
  if (strategy === 'hermes') {
    check('  a Hermes runtime still reports its dashboard, separately', dashboard !== undefined)
  } else {
    check(
      '  nothing about Hermes appears on a non-Hermes runtime',
      !/hermes/i.test(JSON.stringify(info)),
      JSON.stringify(info).slice(0, 160),
    )
  }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
