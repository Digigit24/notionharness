import type { CollectionConfig } from 'payload'
import { inMyAdministeredWorkspaces, inMyWorkspaces } from './access'

/**
 * A machine this workspace's people run agents from — Machine A, Machine B,
 * whatever they choose to call it. Purely a name and an identity key; it
 * owns nothing else. `runtime_profiles.host_id` (see that collection and
 * `lib/broker/runs.ts`'s `claimNextRun`) already carries the raw identity
 * (`hostKey` here, from `lib/runtimes/host-id.ts`) that actually decides
 * which machine's dispatcher may claim a run — this collection exists only
 * so a person sees "Vaibhav's Desktop" instead of a raw hostname, and so
 * "add a machine" is one action rather than something implied by adding its
 * first runtime profile.
 *
 * `hostKey` is NOT unique at the Payload field level (Postgres composite
 * uniqueness needs a real index, not a single-column constraint) — see the
 * migration for the real `(workspace_id, host_key)` unique index. Writing is
 * `administer` for the same reason as `RuntimeProfiles`: naming a machine is
 * ordinary, but its `hostKey` is what agents will actually be bound to run
 * against, which is the same "what this machine executes" decision.
 */
export const RuntimeHosts: CollectionConfig = {
  slug: 'runtime-hosts',
  access: {
    read: inMyWorkspaces(),
    create: inMyAdministeredWorkspaces(),
    update: inMyAdministeredWorkspaces(),
    delete: inMyAdministeredWorkspaces(),
  },
  admin: { useAsTitle: 'displayName' },
  fields: [
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'displayName', type: 'text', required: true },
    // The raw identity `lib/runtimes/host-id.ts`'s `currentHostId()` resolves
    // to on that machine (its hostname, or `MACHINE_ID` if set). Never shown
    // to a person as the primary label — `displayName` is — but it is the
    // value `runtime_profiles.host_id` is compared against at claim time, so
    // it must be exactly what that machine's own server actions compute.
    { name: 'hostKey', type: 'text', required: true },
    { name: 'addedBy', type: 'relationship', relationTo: 'users' },
  ],
}

export default RuntimeHosts
