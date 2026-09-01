import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RecordDetailPopover } from '@/components/database/record-detail-popover'

// Bridges the shared React record-detail popover into a lit/BlockSuite block.
// Mounted straight onto `document.body` (matching how BlockSuite's own
// SlashMenu popover attaches outside the block's DOM subtree) so the modal's
// `fixed inset-0` overlay isn't clipped by any ancestor's overflow/transform.

let container: HTMLElement | null = null
let root: Root | null = null

export function openRecordDetail(params: { teableTableId: string; recordId: string; onUpdated?: () => void }) {
  closeRecordDetail()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  root.render(
    createElement(RecordDetailPopover, {
      teableTableId: params.teableTableId,
      recordId: params.recordId,
      onClose: closeRecordDetail,
      onUpdated: params.onUpdated,
    }),
  )
}

export function closeRecordDetail() {
  root?.unmount()
  container?.remove()
  root = null
  container = null
}
