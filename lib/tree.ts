import type { Page } from '@/payload-types'

export type PageNode = Page & { children: PageNode[] }

function parentId(page: Page): number | null {
  if (!page.parentPage) return null
  return typeof page.parentPage === 'number' ? page.parentPage : page.parentPage.id
}

/** Builds a nested tree from a flat, workspace-scoped page list. Orphans (parent outside the set) become roots. */
export function buildPageTree(pages: Page[]): PageNode[] {
  const nodes = new Map<number, PageNode>()
  for (const page of pages) nodes.set(page.id, { ...page, children: [] })

  const roots: PageNode[] = []
  for (const page of pages) {
    const node = nodes.get(page.id)!
    const pid = parentId(page)
    const parent = pid !== null ? nodes.get(pid) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const byPosition = (a: PageNode, b: PageNode) => (a.position ?? 0) - (b.position ?? 0)
  const sortRec = (list: PageNode[]) => {
    list.sort(byPosition)
    for (const n of list) sortRec(n.children)
  }
  sortRec(roots)

  return roots
}

/** Ancestor chain from the workspace root down to (and including) `pageId`. */
export function buildBreadcrumbChain(pages: Page[], pageId: number): Page[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const chain: Page[] = []
  let current = byId.get(pageId)
  const seen = new Set<number>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.unshift(current)
    const pid = parentId(current)
    current = pid !== null ? byId.get(pid) : undefined
  }
  return chain
}

/** All descendant ids of `pageId` (not including itself), used to guard against reparenting a page under its own subtree. */
export function descendantIds(pages: Page[], pageId: number): Set<number> {
  const childrenByParent = new Map<number, number[]>()
  for (const page of pages) {
    const pid = parentId(page)
    if (pid === null) continue
    const list = childrenByParent.get(pid) ?? []
    list.push(page.id)
    childrenByParent.set(pid, list)
  }

  const result = new Set<number>()
  const queue = [...(childrenByParent.get(pageId) ?? [])]
  while (queue.length) {
    const id = queue.shift()!
    if (result.has(id)) continue
    result.add(id)
    queue.push(...(childrenByParent.get(id) ?? []))
  }
  return result
}
