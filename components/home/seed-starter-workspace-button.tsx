'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { seedStarterWorkspaceIfEmpty } from '@/app/(app)/workspace/[workspaceSlug]/actions'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'

// Phase C, C4 — "wire it into first-run so a fresh install has a starter
// project." The three FirstRunChecklist steps are still real, manual,
// unskippable-in-spirit actions (connect a provider, create an agent, run
// a task) — this button is the shortcut: one click does all three via
// `lib/onboarding/seed-starter-workspace.ts`, landing on the sample
// "Welcome" page it creates so the result is immediately visible.
export function SeedStarterWorkspaceButton({ workspaceId, workspaceSlug }: { workspaceId: number; workspaceSlug: string }) {
  const router = useRouter()
  const [seeding, setSeeding] = useState(false)
  const [isPending, startTransition] = useTransition()

  async function seed() {
    setSeeding(true)
    try {
      const result = await seedStarterWorkspaceIfEmpty({ workspaceId, workspaceSlug })
      toast({ title: 'Seeded a starter project, agent, task, and page' })
      startTransition(() => router.push(`/workspace/${workspaceSlug}/p/${result.pageId}`))
    } catch (error) {
      toast({
        title: 'Could not seed starter content',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      setSeeding(false)
    }
  }

  return (
    <Button type="button" size="sm" variant="outline" disabled={seeding || isPending} onClick={() => void seed()}>
      <Sparkles size={14} />
      {seeding ? 'Seeding…' : 'Or, seed starter content for me'}
    </Button>
  )
}
