import type { CollectionConfig } from 'payload'

// ROADMAP P2.1 — minimal scaffolding for later agent-run-output attachment
// (Pillar 4+) — deliberately not over-built now: just enough shape (name +
// a URL/reference) to exist and be linkable from a task.
export const Artifacts: CollectionConfig = {
  slug: 'artifacts',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'task',
      type: 'relationship',
      relationTo: 'tasks',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'url',
      type: 'text',
      required: true,
      admin: {
        description: 'Reference to the artifact\'s content — a URL for now.',
      },
    },
  ],
}

export default Artifacts
