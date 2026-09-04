'use client'

// The changed-file tree for the review surface.
//
// Structurally the same tree the old `components/runs/review-panel.tsx` drew
// deliberately a second copy rather than an import: that file was outside this
// unit's owned paths, so it could not be refactored to export the tree, and
// leaving the new surface without a file list to avoid ~40 lines of overlap
// would have been the worse trade. It differs where it has to — it carries the
// per-file comment count, and it prefetches a file's patch on hover so the
// click itself is free (D0: no round trip on a UI action).
import { ChevronDown, ChevronRight, File, MessageSquare } from 'lucide-react'
import type { ChangedFile, FileChangeStatus } from '@/lib/run-worktrees/diff'

export interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  file: ChangedFile | null
}

export function buildFileTree(files: ChangedFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [], file: null }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    parts.forEach((part, idx) => {
      const isLeaf = idx === parts.length - 1
      let child = node.children.find((c) => c.name === part && (c.file !== null) === isLeaf)
      if (!child) {
        child = { name: part, path: parts.slice(0, idx + 1).join('/'), children: [], file: isLeaf ? file : null }
        node.children.push(child)
      }
      node = child
    })
  }
  const sortTree = (node: TreeNode) => {
    node.children.sort((a, b) => {
      const aIsDir = a.file === null
      const bIsDir = b.file === null
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    node.children.forEach(sortTree)
  }
  sortTree(root)
  return root.children
}

const STATUS_STYLES: Record<FileChangeStatus, string> = {
  added: 'text-green-600 dark:text-green-400',
  modified: 'text-amber-600 dark:text-amber-400',
  deleted: 'text-red-600 dark:text-red-400',
  renamed: 'text-purple-600 dark:text-purple-400',
  copied: 'text-purple-600 dark:text-purple-400',
  unknown: 'text-black/50 dark:text-white/50',
}

const STATUS_LABELS: Record<FileChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  unknown: '?',
}

export function ReviewFileTree({
  nodes,
  expanded,
  onToggle,
  selected,
  onSelect,
  onPrefetch,
  commentCounts,
  depth = 0,
}: {
  nodes: TreeNode[]
  expanded: Set<string>
  onToggle: (path: string) => void
  selected: ChangedFile | null
  onSelect: (file: ChangedFile) => void
  onPrefetch: (file: ChangedFile) => void
  /** Open (not yet sent) comment count per file path. */
  commentCounts: Map<string, number>
  depth?: number
}) {
  return (
    <div style={{ paddingLeft: depth ? 12 : 0 }}>
      {nodes.map((node) =>
        node.file ? (
          <button
            key={node.path}
            type="button"
            onClick={() => onSelect(node.file!)}
            // Pointer-enter, not focus or click: by the time the pointer has
            // travelled the last few pixels the `git diff` is usually already
            // back, so selecting a file paints immediately.
            onPointerEnter={() => onPrefetch(node.file!)}
            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs ${
              selected?.path === node.file.path
                ? 'bg-black/[.06] dark:bg-white/[.08]'
                : 'hover:bg-black/[.04] dark:hover:bg-white/[.06]'
            }`}
          >
            <span className={`shrink-0 font-mono font-semibold ${STATUS_STYLES[node.file.status]}`}>
              {STATUS_LABELS[node.file.status]}
            </span>
            <File size={12} className="shrink-0 text-black/40 dark:text-white/40" />
            <span className="truncate">{node.name}</span>
            {(commentCounts.get(node.file.path) ?? 0) > 0 && (
              <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded bg-amber-500/20 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                <MessageSquare size={9} />
                {commentCounts.get(node.file.path)}
              </span>
            )}
          </button>
        ) : (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => onToggle(node.path)}
              className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs font-medium hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            >
              {expanded.has(node.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {node.name}
            </button>
            {expanded.has(node.path) && (
              <ReviewFileTree
                nodes={node.children}
                expanded={expanded}
                onToggle={onToggle}
                selected={selected}
                onSelect={onSelect}
                onPrefetch={onPrefetch}
                commentCounts={commentCounts}
                depth={depth + 1}
              />
            )}
          </div>
        ),
      )}
    </div>
  )
}
