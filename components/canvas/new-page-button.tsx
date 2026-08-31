'use client'

import { createPage } from '@/app/(app)/actions'

export function NewPageButton({
  workspaceId,
  workspaceSlug,
  label = 'Create a page',
}: {
  workspaceId: number
  workspaceSlug: string
  label?: string
}) {
  return (
    <button
      type="button"
      onClick={() => void createPage({ workspaceId, workspaceSlug, parentPageId: null })}
      className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/80"
    >
      {label}
    </button>
  )
}
