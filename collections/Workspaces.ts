import type { CollectionConfig } from 'payload'

export const Workspaces: CollectionConfig = {
  slug: 'workspaces',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'icon',
      type: 'text',
      admin: {
        description: 'Emoji or icon identifier',
      },
    },
    {
      name: 'owner',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      hasMany: false,
    },
    {
      name: 'members',
      type: 'relationship',
      relationTo: 'users',
      hasMany: true,
    },
    {
      name: 'taskPrefix',
      type: 'text',
      admin: {
        description: 'Short, human-readable task-id prefix for this workspace (e.g. "ENG") — combined with taskCounter for IDs like ENG-142. Not yet surfaced in any UI.',
      },
    },
    {
      name: 'taskCounter',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Last-issued sequence number for this workspace\'s human-readable task IDs — increment and read atomically when actually wiring ENG-142-style IDs.',
      },
    },
    {
      // ROADMAP B7.2 (Batch B-6 "Finish") — paired with
      // migrations/20260902_150000_spend_caps.ts's spend_cap_cents column;
      // both land together, never as two separate steps (see that
      // migration's own header comment for why — `workspaces` is read on
      // nearly every page load). NULL/unset = uncapped. Dispatcher-side
      // fail-closed enforcement is a separate, still-unbuilt gap — see
      // components/workspace/spend-cap-form.tsx's own caveat.
      name: 'spendCapCents',
      type: 'number',
      min: 0,
      admin: {
        description: 'Monthly spend cap in cents for this workspace, or empty for uncapped. Not yet enforced by the dispatcher (see AGENTS.md B-6 entry).',
      },
    },
  ],
}

export default Workspaces
