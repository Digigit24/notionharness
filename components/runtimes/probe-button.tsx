'use client'

import { useState, useTransition } from 'react'
import { CheckCircle2, Loader2, Plug, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  probeRuntimeProfile,
  type RuntimeProbeOutcome,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/runtimes/actions'
import { unwrap } from '@/lib/failures'
import { explainProbeCode } from '@/lib/runtimes/probe-codes'

/**
 * Runs the two-step ACP probe against a runtime and shows what came back.
 *
 * The code is the signal, not the sentence — `command_not_found` means install
 * it; `acp_init_failed` means it is there but did not speak the protocol,
 * which is usually a wrapper or version problem. Collapsing those into one
 * "unavailable" makes the reader guess which of two very different fixes
 * applies.
 *
 * R1.A.3 — but the code alone made the reader guess too, just at a different
 * step: it was printed raw and nothing said what to do about it. The code is
 * still shown, because it is the thing to search a log for; it is now shown
 * NEXT to the sentences `lib/runtimes/probe-codes.ts` maps it to, so the
 * screen names the fix instead of naming the failure.
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
  const [result, setResult] = useState<RuntimeProbeOutcome | null>(
    lastCode ? { ok: lastCode === 'ok', code: lastCode, detail: lastDetail ?? '', agentName: agentName ?? null } : null,
  )
  // Kept apart from `result` on purpose: "the probe could not be started"
  // (not logged in, profile deleted under you) is not a probe verdict, and
  // filing it under one of the probe's own codes would put a diagnosis on
  // screen that no probe ever produced.
  const [error, setError] = useState<string | null>(null)

  const explanation = explainProbeCode(result?.code)

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            try {
              setResult(unwrap(await probeRuntimeProfile({ id: profileId, workspaceSlug })))
            } catch (err) {
              setError(err instanceof Error ? err.message : 'The probe could not be started.')
            }
          })
        }
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
        {busy ? 'Probing…' : 'Probe'}
      </Button>

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {result && (
        <div
          className={`flex items-start gap-1 text-[11px] ${
            result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
          }`}
        >
          {result.ok ? (
            <CheckCircle2 size={11} className="mt-0.5 shrink-0" />
          ) : (
            <XCircle size={11} className="mt-0.5 shrink-0" />
          )}
          <div className="min-w-0">
            <p>
              {/* An unrecognised code (a row written by an older build) has no
                  sentence to show, so the code stands in as the headline
                  rather than being dropped for something vaguer. */}
              <span className="font-medium">{explanation?.title ?? result.code}</span>
              {result.agentName ? ` · ${result.agentName}` : ''}
            </p>
            {explanation && !result.ok && (
              <p className="text-black/60 dark:text-white/60">
                {explanation.whatItMeans} <span className="font-medium">{explanation.whatToDo}</span>
              </p>
            )}
            <p className="text-black/45 dark:text-white/45">
              <code className="font-mono">{result.code}</code>
              {result.detail ? ` — ${result.detail}` : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
