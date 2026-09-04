'use client'

import { useState, useTransition } from 'react'
import { CheckCircle2, Loader2, Plug, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { probeRuntimeProfile } from '@/app/(app)/workspace/[workspaceSlug]/settings/runtimes/actions'

/**
 * Runs the two-step ACP probe against a runtime and shows what came back.
 *
 * The code is the signal, not the sentence. `command_not_found` means install
 * it; `acp_init_failed` means it is there but did not speak the protocol,
 * which is usually a wrapper or version problem. Collapsing those into one
 * "unavailable" makes the reader guess which of two very different fixes
 * applies.
 */
export function RuntimeProbeButton({
  profileId,
  workspaceSlug,
  lastCode,
  lastDetail,
  agentName,
}: {
  profileId: number
  workspaceSlug: string
  lastCode?: string | null
  lastDetail?: string | null
  agentName?: string | null
}) {
  const [busy, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; code: string; detail: string; agentName: string | null } | null>(
    lastCode ? { ok: lastCode === 'ok', code: lastCode, detail: lastDetail ?? '', agentName: agentName ?? null } : null,
  )

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          startTransition(async () => {
            try {
              setResult(await probeRuntimeProfile({ id: profileId, workspaceSlug }))
            } catch (err) {
              setResult({
                ok: false,
                code: 'spawn_failed',
                detail: err instanceof Error ? err.message : 'The probe failed.',
                agentName: null,
              })
            }
          })
        }
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
        {busy ? 'Probing…' : 'Probe'}
      </Button>

      {result && (
        <p
          className={`flex items-start gap-1 text-[11px] ${
            result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
          }`}
        >
          {result.ok ? (
            <CheckCircle2 size={11} className="mt-0.5 shrink-0" />
          ) : (
            <XCircle size={11} className="mt-0.5 shrink-0" />
          )}
          <span className="min-w-0">
            <code className="font-mono">{result.code}</code>
            {result.agentName ? ` · ${result.agentName}` : ''}
            {result.detail ? ` — ${result.detail}` : ''}
          </span>
        </p>
      )}
    </div>
  )
}
