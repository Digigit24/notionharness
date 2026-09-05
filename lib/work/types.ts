import type { SessionConfigOption } from '@/lib/runtimes/handshake'
import type { ActiveModelConfig } from '@/lib/runtimes/hermes/providers'

/**
 * Shapes shared between `work-view.tsx` and `hero-composer.tsx`.
 *
 * Pulled out to their own module rather than left inline in `work-view.tsx`
 * (where they lived before the hero redesign) so the hero composer can import
 * them without a circular import — `work-view.tsx` imports `HeroComposer`,
 * so `hero-composer.tsx` importing types back from `work-view.tsx` would be
 * a cycle. `work-view.tsx` re-exports both names, so nothing that already
 * imported them from there needs to change.
 */
export interface WorkAgent {
  id: number
  name: string
  profile: string
  model: ActiveModelConfig | null
  /** Settings this agent's runtime declares for a session — its model, effort
   * level, permission mode. `undefined` when the runtime has never been
   * probed, which is a different answer from an empty list. */
  runtimeOptions?: SessionConfigOption[]
  /** The agent's own saved values, which the composer chips start from. */
  runtimeDefaults?: Record<string, unknown>
}

export interface WorkProject {
  id: number
  name: string
}
