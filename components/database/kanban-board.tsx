import { useMemo, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { colorClasses, formatReadOnly, type TeableField, type TeableRecord } from '@/components/database/teable-types'

const NO_STATUS_ID = '__no_status__'

export interface KanbanBoardProps {
  teableTableId: string
  fields: TeableField[]
  records: TeableRecord[]
  groupingField: TeableField
  onOpenRecord: (recordId: string) => void
}

function columnIdForRecord(record: TeableRecord, groupingField: TeableField): string {
  const raw = record.fields[groupingField.name]
  const choices = groupingField.options?.choices ?? []
  return typeof raw === 'string' && choices.some((c) => c.name === raw) ? raw : NO_STATUS_ID
}

export function KanbanBoard({ teableTableId, fields, records: initialRecords, groupingField, onOpenRecord }: KanbanBoardProps) {
  const [records, setRecords] = useState(initialRecords)
  const [error, setError] = useState<string | null>(null)

  const titleField = fields[0] ?? null
  const featuredFields = useMemo(
    () => fields.filter((f) => f.id !== groupingField.id && f.id !== titleField?.id).slice(0, 3),
    [fields, groupingField.id, titleField?.id],
  )

  const columns = useMemo(() => {
    const choiceColumns = (groupingField.options?.choices ?? []).map((c) => ({ id: c.name, label: c.name, color: c.color as string | undefined }))
    return [...choiceColumns, { id: NO_STATUS_ID, label: 'No status', color: undefined }]
  }, [groupingField])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  async function patchGroupField(recordId: string, columnId: string) {
    const value = columnId === NO_STATUS_ID ? null : columnId
    try {
      const res = await fetch(`/api/teable/tables/${teableTableId}/records/${recordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: { fields: { [groupingField.name]: value } } }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || 'Failed to move card.')
      }
    } catch (err) {
      setRecords(initialRecords)
      setError(err instanceof Error ? err.message : 'Failed to move card.')
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const recordId = String(active.id)
    const targetColumnId = String(over.id)
    const record = records.find((r) => r.id === recordId)
    if (!record) return
    if (columnIdForRecord(record, groupingField) === targetColumnId) return

    setError(null)
    setRecords((prev) =>
      prev.map((r) =>
        r.id === recordId
          ? { ...r, fields: { ...r.fields, [groupingField.name]: targetColumnId === NO_STATUS_ID ? null : targetColumnId } }
          : r,
      ),
    )
    void patchGroupField(recordId, targetColumnId)
  }

  async function handleAddCard(columnId: string) {
    const value = columnId === NO_STATUS_ID ? null : columnId
    try {
      const res = await fetch(`/api/teable/tables/${teableTableId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: { [groupingField.name]: value } }] }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to add card.')
      const created: TeableRecord[] = json.records ?? (json.record ? [json.record] : [])
      setRecords((prev) => [...prev, ...created])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add card.')
    }
  }

  return (
    <div className="flex flex-col">
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </div>
      )}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto p-3">
          {columns.map((col) => (
            <KanbanColumn
              key={col.id}
              id={col.id}
              label={col.label}
              color={col.color}
              records={records.filter((r) => columnIdForRecord(r, groupingField) === col.id)}
              titleField={titleField}
              featuredFields={featuredFields}
              onOpenRecord={onOpenRecord}
              onAddCard={() => void handleAddCard(col.id)}
            />
          ))}
        </div>
      </DndContext>
    </div>
  )
}

function KanbanColumn({
  id,
  label,
  color,
  records,
  titleField,
  featuredFields,
  onOpenRecord,
  onAddCard,
}: {
  id: string
  label: string
  color: string | undefined
  records: TeableRecord[]
  titleField: TeableField | null
  featuredFields: TeableField[]
  onOpenRecord: (recordId: string) => void
  onAddCard: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      className={`flex w-64 shrink-0 flex-col rounded-lg border ${isOver ? 'border-black/30 dark:border-white/30' : 'border-black/10 dark:border-white/10'} bg-black/[.015] dark:bg-white/[.02]`}
    >
      <div className="flex items-center justify-between gap-2 px-2 py-2">
        <span className={`truncate rounded px-1.5 py-0.5 text-xs font-medium ${colorClasses(color)}`}>{label}</span>
        <span className="shrink-0 text-xs text-black/30 dark:text-white/30">{records.length}</span>
      </div>
      <div className="flex min-h-[40px] flex-1 flex-col gap-1.5 px-2 pb-2">
        {records.map((r) => (
          <KanbanCard key={r.id} record={r} titleField={titleField} featuredFields={featuredFields} onOpenRecord={onOpenRecord} />
        ))}
      </div>
      <button
        type="button"
        className="mx-2 mb-2 rounded px-2 py-1 text-left text-xs text-black/40 hover:bg-black/[.06] dark:text-white/40 dark:hover:bg-white/[.08]"
        onClick={onAddCard}
      >
        + Add card
      </button>
    </div>
  )
}

function KanbanCard({
  record,
  titleField,
  featuredFields,
  onOpenRecord,
}: {
  record: TeableRecord
  titleField: TeableField | null
  featuredFields: TeableField[]
  onOpenRecord: (recordId: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: record.id })
  const title = titleField ? formatReadOnly(record.fields[titleField.name]) : ''

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpenRecord(record.id)}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 10 } : undefined}
      className={`cursor-grab rounded-md border border-black/10 bg-white p-2 text-sm shadow-sm hover:border-black/20 active:cursor-grabbing dark:border-white/10 dark:bg-[#2a2a2a] dark:hover:border-white/20 ${isDragging ? 'opacity-50' : ''}`}
    >
      <div className="truncate font-medium">{title || 'Untitled'}</div>
      {featuredFields.length > 0 && (
        <div className="mt-1 flex flex-col gap-1">
          {featuredFields.map((f) => {
            const value = record.fields[f.name]
            if (value === null || value === undefined || value === '') return null
            const isSelect = f.type === 'singleSelect' || f.type === 'multipleSelect'
            const choices = f.options?.choices ?? []
            if (isSelect) {
              const names = Array.isArray(value) ? (value as string[]) : [value as string]
              return (
                <div key={f.id} className="flex flex-wrap gap-1">
                  {names.map((name) => {
                    const choice = choices.find((c) => c.name === name)
                    return (
                      <span key={name} className={`rounded px-1.5 py-0.5 text-[11px] ${colorClasses(choice?.color)}`}>
                        {name}
                      </span>
                    )
                  })}
                </div>
              )
            }
            return (
              <div key={f.id} className="truncate text-xs text-black/50 dark:text-white/50">
                {formatReadOnly(value)}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
