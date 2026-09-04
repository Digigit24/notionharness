import { buildHermesHomeOverlay } from './home-overlay'
import {
  registerRuntimeHomeStrategy,
  type RuntimeHomeStrategy,
} from '@/lib/runtimes/home'

/**
 * Hermes's implementation of the runtime home contract.
 *
 * Thin on purpose: the overlay logic itself is unchanged and still lives in
 * `home-overlay.ts`. This only expresses it in the shape every runtime
 * answers, so the dispatcher can ask "give this agent its home" without
 * knowing which CLI is behind it.
 *
 * `baseHome` is the optional Hermes profile. Given one, the overlay inherits
 * that profile's config and credentials; given none, it builds from the
 * install root plus this agent's own memories and skills. Both paths already
 * existed — the point of the abstraction is that neither is now mandatory.
 */
export const hermesHomeStrategy: RuntimeHomeStrategy = {
  id: 'hermes',
  label: 'Hermes agent home',
  async materialise(request) {
    const overlay = await buildHermesHomeOverlay({
      runId: request.runId,
      agentId: request.agentId,
      conversationId: request.conversationId,
      enabledSkills: request.enabledSkills,
      baseHermesHome: request.baseHome,
    })
    return {
      env: { HERMES_HOME: overlay.homeDir },
      missingSkills: overlay.missingSkills,
      cleanup: overlay.cleanup,
    }
  },
}

registerRuntimeHomeStrategy(hermesHomeStrategy)
