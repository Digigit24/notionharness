import { hostname } from 'node:os'

/**
 * This process's identity for host-scoped runtime claiming.
 *
 * A runtime profile names a binary on the machine that created it
 * (`collections/RuntimeProfiles.ts`'s own header comment has always said so);
 * `runtime_profiles.host_id` is what lets the dispatcher's claim query
 * (`lib/broker/runs.ts`'s `claimNextRun`) actually honour that, instead of
 * letting any machine's dispatcher loop claim a run whose agent's profile
 * only exists somewhere else.
 *
 * `os.hostname()` is the zero-configuration default — distinct machines
 * overwhelmingly have distinct hostnames, so two people running this app on
 * their own PCs against one shared database get correct host-scoping without
 * setting anything. `MACHINE_ID` exists for the cases hostname can't cover:
 * two containers sharing one hostname, or a machine whose hostname changes
 * across reinstalls while its runtime installs do not.
 */
export function currentHostId(): string {
  const override = process.env.MACHINE_ID?.trim()
  return override || hostname()
}
