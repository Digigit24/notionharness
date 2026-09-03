import type { GlobalConfig } from 'payload'

// Phase C, C1.1 — DB-backed Hermes connection settings, replacing
// `HERMES_API_BASE_URL`/`HERMES_API_KEY` env vars as the long-term config
// source (env stays as a fallback for machines/CI that never touch the UI —
// see lib/hermes-api.ts's own comment). A Payload Global, not a collection:
// there is exactly one Hermes per installation as of C1 (see AGENTS.md's
// Phase C notes on why multi-runtime is deferred to Pillar 8), so there is
// no natural per-row identity a collection would need.
//
// NOT YET REGISTERED in payload.config.ts's `globals` array — its backing
// table (migrations/20260903_130000_hermes_config.ts) has not been applied
// to the live DB. Registering a Global whose table doesn't exist would
// break every request that touches it. This file exists so the shape is
// reviewable and ready; wiring it in is the deliberate human step described
// in that migration's own comment.
export const HermesConfig: GlobalConfig = {
  slug: 'hermes-config',
  access: {
    // Every route that reads this needs an authenticated Payload user
    // (matching Workspaces' own access pattern from the earlier access-
    // control fix this session) — there is exactly one Hermes config for
    // the whole installation, so "read" here doesn't need per-workspace
    // scoping the way Workspaces did.
    read: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'baseUrl', type: 'text', admin: { description: 'e.g. https://your-hermes-host/v1' } },
    {
      name: 'apiKey',
      type: 'text',
      admin: {
        description: 'Bearer token for Hermes requests, if your Hermes install requires one.',
        // Payload's admin UI never round-trips this field's real value back
        // to the client on read (see `Users`' own `auth` field handling
        // elsewhere in this codebase for the same posture) — a form should
        // show it masked and only send a new value when actually changed.
      },
    },
    { name: 'verified', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
    { name: 'lastVerifiedAt', type: 'date', admin: { readOnly: true } },
    { name: 'lastError', type: 'text', admin: { readOnly: true, description: 'Set by the last failed Test Connection attempt.' } },
  ],
}

export default HermesConfig
