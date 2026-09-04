// Probe one ACP runtime command from the terminal, the same way the Runtimes
// page does. Useful when a probe fails and you want the raw answer without a
// browser in the way.
//
//   npx tsx scripts/probe-runtime.ts "claude-agent-acp"
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { probeAcpRuntime, sessionConfigOptions } = await import('../lib/runtimes/detect')

const command = process.argv[2]
if (!command) throw new Error('Usage: npx tsx scripts/probe-runtime.ts "<command>"')

const started = Date.now()
const result = await probeAcpRuntime(command, [])
console.log(`command:  ${command}`)
console.log(`code:     ${result.code}`)
console.log(`elapsed:  ${Date.now() - started}ms`)
console.log(`detail:   ${result.detail ?? ''}`)
if (result.handshake) {
  console.log(`agent:    ${result.handshake.agentName ?? 'unknown'}`)
  console.log(`caps:     ${JSON.stringify(result.handshake.capabilities)}`)
  console.log(`modes:    ${JSON.stringify((result.handshake.availableModes ?? []).length)} available, current=${result.handshake.currentModeId ?? 'n/a'}`)
  const options = sessionConfigOptions(result.handshake)
  if (options === undefined) {
    console.log('config:   not reported (no session response)')
  } else if (options.length === 0) {
    console.log('config:   none declared — this runtime chooses its own model')
  } else {
    for (const option of options) {
      const choices = (option.options ?? []).map((c) => c.value).join(', ')
      console.log(`config:   ${option.id} (${option.category ?? 'uncategorised'}) = ${String(option.currentValue)}${choices ? ` [${choices}]` : ''}`)
    }
  }
}
process.exit(result.code === 'ok' ? 0 : 1)
