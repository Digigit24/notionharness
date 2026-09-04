'use client'

import { useState } from 'react'
import { Radio, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { pingAgentRuntime, pingAgentModel } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import { unwrap } from '@/lib/failures'

interface PingResult {
  ok: boolean
  output: string
  durationMs: number
  /** Set by the model ping: which profile/provider/model actually answered. */
  profile?: string
  provider?: string
  model?: string
  /** A green ping with a known problem attached (Hermes install check). */
  warning?: string
}

function ResultLine({ result }: { result: PingResult }) {
  // Naming what answered is the whole point once agents can run on different
  // profiles — "it replied" is not useful if you can't tell WHICH model did.
  const attribution = result.model
    ? `${result.profile || 'install default'} → ${result.provider}/${result.model}`
    : null
  return (
    <p className={`mt-1 text-xs ${result.ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
      {result.ok ? `✓ ${result.output || 'OK'}` : `✗ ${result.output}`}
      {result.durationMs > 0 && <span className="text-black/40 dark:text-white/40"> ({result.durationMs}ms)</span>}
      {attribution && (
        <span className="block text-black/40 dark:text-white/40">via {attribution}</span>
      )}
      {result.warning && (
        <span className="block text-amber-700 dark:text-amber-400">⚠ {result.warning}</span>
      )}
    </p>
  )
}

export function RuntimePingButton({ agentId }: { agentId: number }) {
  const [pinging, setPinging] = useState(false)
  const [runtimeResult, setRuntimeResult] = useState<PingResult | null>(null)
  const [modelPinging, setModelPinging] = useState(false)
  const [modelResult, setModelResult] = useState<PingResult | null>(null)

  async function handlePingRuntime() {
    setPinging(true)
    setRuntimeResult(null)
    try {
      setRuntimeResult(unwrap(await pingAgentRuntime(agentId)))
    } catch (err) {
      setRuntimeResult({ ok: false, output: err instanceof Error ? err.message : 'Ping failed.', durationMs: 0 })
    } finally {
      setPinging(false)
    }
  }

  async function handlePingModel() {
    setModelPinging(true)
    setModelResult(null)
    try {
      setModelResult(unwrap(await pingAgentModel(agentId)))
    } catch (err) {
      setModelResult({ ok: false, output: err instanceof Error ? err.message : 'Test failed.', durationMs: 0 })
    } finally {
      setModelPinging(false)
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div>
        <Button type="button" size="sm" variant="outline" disabled={pinging} onClick={() => void handlePingRuntime()}>
          <Radio size={13} className={pinging ? 'animate-pulse' : undefined} />
          {pinging ? 'Testing…' : 'Test connection'}
        </Button>
        <p className="mt-1 text-[11px] text-black/40 dark:text-white/40">Confirms the binary itself runs.</p>
        {runtimeResult && <ResultLine result={runtimeResult} />}
      </div>

      <div>
        <Button type="button" size="sm" variant="outline" disabled={modelPinging} onClick={() => void handlePingModel()}>
          <Sparkles size={13} className={modelPinging ? 'animate-pulse' : undefined} />
          {modelPinging ? 'Sending…' : 'Test connection with model'}
        </Button>
        <p className="mt-1 text-[11px] text-black/40 dark:text-white/40">
          Sends a real, throwaway message through Hermes&apos;s active model/provider (up to ~45s).
        </p>
        {modelResult && <ResultLine result={modelResult} />}
      </div>
    </div>
  )
}
