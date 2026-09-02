import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { SpendCapForm } from '@/components/workspace/spend-cap-form'

// ROADMAP B7.2 (Batch B-6 "Finish") — the first workspace-level settings
// route in this app (previously only `/settings/notifications` existed, and
// that's deliberately global/per-user, not workspace-scoped — see that
// page's own header comment). Scoped down per this batch's own
// effort-budget allowance: schema field written as a migration (NOT
// applied — migrations/20260902_150000_spend_caps.ts) + this settings UI to
// set it, with the actual save path and dispatcher-side enforcement both
// left as explicit, visible gaps rather than a form that quietly pretends
// to work. See SpendCapForm for why the input is disabled, not just
// decorative copy.
export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-2"
          segments={[
            { label: workspace.name, href: `/workspace/${workspace.slug}` },
            { label: 'Settings' },
          ]}
        />
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">Workspace-level configuration.</p>
      </div>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <h2 className="text-sm font-medium">Spend cap</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          A hard ceiling on this workspace&apos;s agent spend, with a fail-closed option — new runs refuse to start
          once the cap is hit rather than silently keep spending.
        </p>
        <div className="mt-3">
          <SpendCapForm workspaceName={workspace.name} />
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div className="flex items-center gap-2">
          <ShieldAlert size={14} className="text-black/40 dark:text-white/40" />
          <h2 className="text-sm font-medium">Audit log</h2>
        </div>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Every recorded activity in this workspace — who did what, to what, and when.
        </p>
        <Link
          href={`/workspace/${workspace.slug}/audit`}
          className="mt-2 inline-block text-xs font-medium underline underline-offset-2"
        >
          Open the audit log →
        </Link>
      </section>
    </main>
  )
}
