'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'

/**
 * Manual, on-demand trigger for the same check `scripts/run-runtime-health-
 * loop.ts` runs on a timer (see that script's header comment for why the
 * timer is a separate opt-in process rather than something the app starts
 * on its own). This button makes the feature useful immediately, without
 * requiring anyone to have that loop running.
 */
export function RuntimesRefreshButton() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [refreshing, setRefreshing] = useState(false)

  async function refresh() {
    setRefreshing(true)
    try {
      const res = await fetch('/api/runtimes/health-check', { method: 'POST' })
      if (!res.ok) throw new Error(`Health check failed (${res.status})`)
      const result = (await res.json()) as { checked: number }
      toast({ title: `Checked ${result.checked} runtime profile${result.checked === 1 ? '' : 's'}` })
      startTransition(() => router.refresh())
    } catch (error) {
      toast({
        title: 'Could not refresh runtimes',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setRefreshing(false)
    }
  }

  const busy = refreshing || isPending

  return (
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
      <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />
      {busy ? 'Checking…' : 'Refresh'}
    </Button>
  )
}
