'use client'
// Already backend-agnostic — `fields` is whatever `GenericRecord.fields`
// shape a DataSource hands back (see `generic-data-source.ts`), name/value
// pairs regardless of which backend the row came from. Renamed from
// `TeableProperties` as part of generalizing rows-as-pages beyond Teable.
export function RowProperties({ fields }: { fields: Record<string, unknown> }) {
  return <div className="my-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">{Object.entries(fields).map(([name, value]) => <div key={name}><div className="text-xs text-black/40 dark:text-white/40">{name}</div><div className="truncate text-sm">{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}</div></div>)}</div>
}
