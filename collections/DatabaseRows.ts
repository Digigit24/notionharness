import type { CollectionConfig } from 'payload'

// ROADMAP P2.3/D4 — one row of a `databases` doc. `cells` is a flat
// fieldId -> value map (the roadmap's own words: "generic `databases` +
// `database_rows` with `cells jsonb`"); it never needs a schema migration
// when the parent database's `fields` array changes, which is the entire
// point of storing it this way instead of one Postgres column per property.
export const DatabaseRows: CollectionConfig = {
  slug: 'database-rows',
  fields: [
    {
      name: 'database',
      type: 'relationship',
      relationTo: 'databases',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'cells',
      type: 'json',
      defaultValue: {},
      admin: {
        description: 'fieldId -> cell value map',
      },
    },
    {
      name: 'position',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Fractional manual ordering within the database (cheap now, per the roadmap\'s own 2.1 guidance on `position float`)',
      },
    },
  ],
}

export default DatabaseRows
