// Re-probe one runtime profile and store the result, the same way the
// Runtimes page's Probe button does. Exists so a profile can be verified from
// a terminal without a browser round trip.
//
//   npx tsx scripts/reprobe-profile.ts <profileId>
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')
const { probeAcpRuntime } = await import('../lib/runtimes/detect')

const id = Number(process.argv[2])
if (!Number.isSafeInteger(id)) throw new Error('Usage: npx tsx scripts/reprobe-profile.ts <profileId>')

const payload = await getPayloadClient()
const profile = await payload.findByID({ collection: 'runtime-profiles', id, depth: 0, overrideAccess: true })
const args = Array.isArray(profile.fixedArgs) ? profile.fixedArgs.filter((a): a is string => typeof a === 'string') : []

const result = await probeAcpRuntime(profile.commandName, args)
await payload.update({
  collection: 'runtime-profiles',
  id,
  data: {
    handshake: result.handshake ?? null,
    lastProbeCode: result.code,
    lastProbeDetail: result.detail.slice(0, 500),
    lastProbedAt: new Date().toISOString(),
  } as never,
  overrideAccess: true,
})

console.log(`${profile.name}: ${result.code}`)
console.log(result.detail)
process.exit(result.ok ? 0 : 1)
