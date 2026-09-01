'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Copy, FileText, MoreHorizontal, Plus, Star, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PopoverMenu } from '@/components/ui/popover-menu'
import { buildPageTree, type PageNode } from '@/lib/tree'
import { archivePage, duplicatePage, movePage, toggleFavorite } from '@/app/(app)/actions'
import type { Page, Workspace } from '@/payload-types'

type DropZone = 'before' | 'after' | 'inside'

type DndState = {
  draggingId: number | null
  overId: number | null
  overZone: DropZone | null
}

const EMPTY_DND: DndState = { draggingId: null, overId: null, overZone: null }

const DndCtx = createContext<{ state: DndState; setState: (s: DndState) => void } | null>(null)

export function PageTree({
  pages,
  workspace,
  activePageId,
  expandedIds,
  onToggleExpand,
  onCreatePage,
}: {
  pages: Page[]
  workspace: Workspace
  activePageId?: number
  expandedIds: Set<number>
  onToggleExpand: (id: number, forceOpen?: boolean) => void
  onCreatePage: (parentPageId: number | null) => void
}) {
  const tree = buildPageTree(pages.filter((p) => !p.isArchived))
  const [dnd, setDnd] = useState<DndState>(EMPTY_DND)

  return (
    <DndCtx.Provider value={{ state: dnd, setState: setDnd }}>
      <div
        className="flex min-h-4 flex-col"
        onDragOver={(e) => {
          if (dnd.draggingId == null) return
          e.preventDefault()
        }}
        onDrop={(e) => {
          if (dnd.draggingId == null) return
          e.preventDefault()
          void movePage({
            pageId: dnd.draggingId,
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            newParentPageId: null,
            placement: 'end',
          })
          setDnd(EMPTY_DND)
        }}
      >
        {tree.map((node) => (
          <PageTreeItem
            key={node.id}
            node={node}
            depth={0}
            workspace={workspace}
            activePageId={activePageId}
            expandedIds={expandedIds}
            onToggleExpand={onToggleExpand}
            onCreatePage={onCreatePage}
          />
        ))}
        {tree.length === 0 && <p className="px-3 py-1.5 text-xs text-black/40 dark:text-white/40">No pages yet</p>}
      </div>
    </DndCtx.Provider>
  )
}

function PageTreeItem({
  node,
  depth,
  workspace,
  activePageId,
  expandedIds,
  onToggleExpand,
  onCreatePage,
}: {
  node: PageNode
  depth: number
  workspace: Workspace
  activePageId?: number
  expandedIds: Set<number>
  onToggleExpand: (id: number, forceOpen?: boolean) => void
  onCreatePage: (parentPageId: number | null) => void
}) {
  const router = useRouter()
  const ctx = useContext(DndCtx)!
  const { state: dnd, setState: setDnd } = ctx
  const expanded = expandedIds.has(node.id)
  const isActive = node.id === activePageId
  const isOver = dnd.overId === node.id

  function computeZone(e: React.DragEvent<HTMLDivElement>): DropZone {
    const rect = e.currentTarget.getBoundingClientRect()
    const offset = (e.clientY - rect.top) / rect.height
    if (offset < 0.25) return 'before'
    if (offset > 0.75) return 'after'
    return 'inside'
  }

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          setDnd({ draggingId: node.id, overId: null, overZone: null })
        }}
        onDragEnd={() => setDnd(EMPTY_DND)}
        onDragOver={(e) => {
          if (dnd.draggingId == null || dnd.draggingId === node.id) return
          e.preventDefault()
          e.stopPropagation()
          const zone = computeZone(e)
          if (dnd.overId !== node.id || dnd.overZone !== zone) {
            setDnd({ draggingId: dnd.draggingId, overId: node.id, overZone: zone })
          }
        }}
        onDrop={(e) => {
          if (dnd.draggingId == null || dnd.draggingId === node.id) return
          e.preventDefault()
          e.stopPropagation()
          const zone = dnd.overZone ?? 'after'
          const draggingId = dnd.draggingId
          setDnd(EMPTY_DND)
          void handleDrop(draggingId, node, zone, workspace)
        }}
        className={cn(
          'group relative flex items-center gap-1 rounded-md px-2 py-1 text-sm cursor-pointer',
          isActive ? 'bg-black/[.06] dark:bg-white/[.08]' : 'hover:bg-black/[.04] dark:hover:bg-white/[.06]',
          isOver && dnd.overZone === 'inside' && 'ring-1 ring-inset ring-blue-500',
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {isOver && dnd.overZone === 'before' && (
          <span className="absolute left-2 right-2 top-0 h-0.5 rounded bg-blue-500" />
        )}
        {isOver && dnd.overZone === 'after' && (
          <span className="absolute left-2 right-2 bottom-0 h-0.5 rounded bg-blue-500" />
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand(node.id)
          }}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10',
            node.children.length === 0 && 'invisible',
          )}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        <Link
          href={`/workspace/${workspace.slug}/p/${node.id}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate"
        >
          <span className="shrink-0">
            {node.icon || <FileText size={14} className="text-black/40 dark:text-white/40" />}
          </span>
          <span className="truncate">{node.title || 'Untitled'}</span>
        </Link>

        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            type="button"
            title="Add sub-page"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(node.id, true)
              onCreatePage(node.id)
            }}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10"
          >
            <Plus size={13} />
          </button>
          <PopoverMenu
            align="end"
            trigger={({ toggle }) => (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggle()
                }}
                className="flex h-5 w-5 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10"
              >
                <MoreHorizontal size={13} />
              </button>
            )}
          >
            {(close) => (
              <div className="flex flex-col text-sm">
                <MenuButton
                  icon={<Star size={14} className={node.isFavorite ? 'fill-yellow-400 text-yellow-400' : ''} />}
                  label={node.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
                  onClick={() => {
                    close()
                    void toggleFavorite(node.id, workspace.slug, !node.isFavorite)
                  }}
                />
                <MenuButton
                  icon={<Copy size={14} />}
                  label="Duplicate"
                  onClick={() => {
                    close()
                    void duplicatePage(node.id, workspace.slug)
                  }}
                />
                <MenuButton
                  icon={<Trash2 size={14} />}
                  label="Move to Trash"
                  danger
                  onClick={() => {
                    close()
                    void archivePage(node.id, workspace.id, workspace.slug)
                    if (isActive) router.push(`/workspace/${workspace.slug}`)
                  }}
                />
              </div>
            )}
          </PopoverMenu>
        </div>
      </div>

      {expanded &&
        node.children.map((child) => (
          <PageTreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            workspace={workspace}
            activePageId={activePageId}
            expandedIds={expandedIds}
            onToggleExpand={onToggleExpand}
            onCreatePage={onCreatePage}
          />
        ))}
    </div>
  )
}

function MenuButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/[.06] dark:hover:bg-white/[.08]',
        danger && 'text-red-600 dark:text-red-400',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

async function handleDrop(draggingId: number, target: PageNode, zone: DropZone, workspace: Workspace) {
  if (zone === 'inside') {
    await movePage({
      pageId: draggingId,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      newParentPageId: target.id,
      placement: 'end',
    })
    return
  }

  const parentId = target.parentPage
    ? typeof target.parentPage === 'number'
      ? target.parentPage
      : target.parentPage.id
    : null

  await movePage({
    pageId: draggingId,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    newParentPageId: parentId,
    placement: zone,
    referenceId: target.id,
  })
}
