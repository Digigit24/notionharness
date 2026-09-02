import { Bell } from 'lucide-react'
import { getNotificationPreferences } from './actions'
import { NotificationPreferencesForm } from '@/components/notifications/notification-preferences-form'
import { PushSubscribeToggle } from '@/components/notifications/push-subscribe-toggle'

// ROADMAP B5.3 (Batch B-5 "Attention") — the settings surface the plan asks
// for: "a real settings UI (even minimal) letting a user toggle which
// events they want pushed." Deliberately global (not under
// `workspace/[workspaceSlug]`) — notification preferences, like the
// Notifications bell itself (see app/(app)/notifications/actions.ts's own
// header comment), are cross-workspace, per-user state.
//
// Not yet linked from the sidebar (B-0's navigation model only wires routes
// that already exist at the time it ran; this route is new this batch) —
// the Inbox header links here directly, and the one-line sidebar addition
// is documented in this batch's final summary for whoever next touches
// components/sidebar/sidebar.tsx.
export default async function NotificationSettingsPage() {
  const preferences = await getNotificationPreferences().catch(() => null)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-8">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Bell size={20} />
            Notifications
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose what pushes to this device and what shows up in your inbox.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">This device</h2>
          <PushSubscribeToggle />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">Events</h2>
          {preferences ? (
            <NotificationPreferencesForm initial={preferences} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Notification preferences aren&apos;t set up on this environment yet (the backing table hasn&apos;t
              been migrated in). Every event defaults to on until it is.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-1 border-t border-border pt-6">
          <h2 className="text-sm font-medium text-foreground">Daily email digest</h2>
          <p className="text-sm text-muted-foreground">
            The digest query (what would go in today&apos;s email — pending approvals and completions since
            the last digest) is real (<code>lib/notifications/digest.ts</code>). Actually sending and
            scheduling that email is not wired up yet — enabling the toggle above records your preference
            for when it is.
          </p>
        </section>
      </div>
    </div>
  )
}
