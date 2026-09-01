'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, LoaderCircle } from 'lucide-react'

type Choice = { id?: string; name: string; color?: string }
type TableField = { id: string; name: string; type?: string; options?: { choices?: Choice[] } }
type RecordData = { id: string; fields?: Record<string, unknown>; name?: string }

export interface RecordDetailPopoverProps {
  teableTableId: string
  recordId: string
  onClose: () => void
  /** Called after an inline field edit has been persisted successfully. */
  onUpdated?: () => void
}

const colorClasses: Record<string, string> = {
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200', blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200',
  green: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-200', red: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-200',
  yellow: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-200',
}
function choiceClass(choice?: Choice) { return colorClasses[choice?.color?.replace(/(Light|Bright)\d*$/, '') || 'gray'] || colorClasses.gray }
function displayValue(value: unknown) { return Array.isArray(value) ? value.map((item) => typeof item === 'object' && item && 'name' in item ? String(item.name) : String(item)).join(', ') : value == null ? '' : String(value) }

export function RecordDetailPopover({ teableTableId, recordId, onClose, onUpdated }: RecordDetailPopoverProps) {
  const [record, setRecord] = useState<RecordData | null>(null)
  const [fields, setFields] = useState<TableField[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    let active = true
    Promise.all([
      fetch(`/api/teable/tables/${encodeURIComponent(teableTableId)}/records/${encodeURIComponent(recordId)}`).then(async (r) => { if (!r.ok) throw new Error('Unable to load record'); return r.json() as Promise<RecordData> }),
      fetch(`/api/teable/tables/${encodeURIComponent(teableTableId)}/fields`).then(async (r) => { if (!r.ok) throw new Error('Unable to load table schema'); return r.json() as Promise<TableField[]> }),
    ]).then(([nextRecord, nextFields]) => { if (active) { setRecord(nextRecord); setFields(nextFields) } }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : 'Unable to load record') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; Object.values(timers.current).forEach(clearTimeout) }
  }, [recordId, teableTableId])

  const save = useCallback((field: TableField, value: unknown) => {
    if (!record) return
    setRecord((current) => current ? { ...current, fields: { ...current.fields, [field.id]: value, [field.name]: value } } : current)
    const old = timers.current[field.id]; if (old) clearTimeout(old)
    timers.current[field.id] = setTimeout(async () => {
      setSaving(field.id)
      try {
        const response = await fetch(`/api/teable/tables/${encodeURIComponent(teableTableId)}/records/${encodeURIComponent(recordId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { [field.id]: value } }) })
        if (!response.ok) throw new Error('Unable to save field')
        onUpdated?.()
      } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save field') } finally { setSaving(null) }
    }, 500)
  }, [onUpdated, record, recordId, teableTableId])

  const title = useMemo(() => record?.name || (record?.fields && displayValue(record.fields.Name)) || 'Record details', [record])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 dark:bg-black/50" role="dialog" aria-modal="true" aria-label="Record details" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="max-h-[min(700px,calc(100vh-2rem))] w-full max-w-xl overflow-y-auto rounded-xl border border-black/10 bg-white shadow-2xl dark:border-white/10 dark:bg-[#252525]">
        <div className="sticky top-0 flex items-center justify-between border-b border-black/10 bg-white/95 px-5 py-4 backdrop-blur dark:border-white/10 dark:bg-[#252525]/95"><h2 className="truncate text-base font-semibold">{title}</h2><button type="button" onClick={onClose} aria-label="Close record details" className="rounded-md p-1.5 text-gray-500 hover:bg-black/5 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"><X size={18} /></button></div>
        {loading && <div className="flex justify-center p-10"><LoaderCircle className="animate-spin text-gray-400" /></div>}
        {error && <p className="m-5 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
        {!loading && record && <div className="space-y-4 p-5">{fields.map((field) => <FieldEditor key={field.id} field={field} value={record.fields?.[field.id] ?? record.fields?.[field.name]} saving={saving === field.id} onChange={(value) => save(field, value)} />)}</div>}
      </div>
    </div>
  )
}

function FieldEditor({ field, value, saving, onChange }: { field: TableField; value: unknown; saving: boolean; onChange: (value: unknown) => void }) {
  const choices = field.options?.choices || []
  const type = field.type || 'singleLineText'
  return <div><label className="mb-1.5 flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">{field.name}{saving && <LoaderCircle size={12} className="animate-spin" />}</label>{type === 'checkbox' ? <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-blue-600" /> : type === 'singleSelect' ? <select value={displayValue(value)} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm dark:border-white/10"> <option value="">Select…</option>{choices.map((choice) => <option key={choice.id || choice.name} value={choice.name}>{choice.name}</option>)}</select> : type === 'multipleSelect' ? <div className="flex flex-wrap gap-1">{choices.map((choice) => { const selected = Array.isArray(value) && value.some((item) => displayValue(item) === choice.name); return <button type="button" key={choice.id || choice.name} onClick={() => onChange(selected ? (value as unknown[]).filter((item) => displayValue(item) !== choice.name) : [...(Array.isArray(value) ? value : []), choice.name])} className={`rounded-full px-2.5 py-1 text-xs ${selected ? choiceClass(choice) : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'}`}>{choice.name}</button> })}</div> : <input type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} value={displayValue(value)} onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)} className="w-full rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/10" />}</div>
}
