// Chat UI components — built on RunEvent stream + shadcn primitives

export { Thread } from './Thread'
export type { ThreadProps } from './Thread'

export { MessageScroller } from './MessageScroller'
export type { MessageScrollerProps } from './MessageScroller'

export { Message } from './Message'
export type { MessageProps } from './Message'

export { Bubble } from './Bubble'
export type { BubbleProps, BubbleType } from './Bubble'

export {
  registerToolRenderer,
  getToolRenderer,
  defaultToolRenderer,
  type ToolRenderer,
  type ToolRendererContext,
} from './tool-renderers'

export { Attachment } from './Attachment'
export type { AttachmentProps } from './Attachment'

export { PermissionCard } from './PermissionCard'
export type { PermissionCardProps } from './PermissionCard'

export { DiffBlock, looksLikeDiff } from './DiffBlock'

export { Marker, TypingIndicator } from './Marker'
export type { MarkerProps, MarkerType } from './Marker'

// Thread layout variants (P5.2 chromes)
export { ThreadDrawerTab } from './ThreadDrawerTab'
export type { ThreadDrawerTabProps } from './ThreadDrawerTab'

export { ThreadFullPage } from './ThreadFullPage'
export type { ThreadFullPageProps } from './ThreadFullPage'

export { ThreadLaneView } from './ThreadLaneView'
export type { ThreadLaneViewProps } from './ThreadLaneView'

// Hook for converting run events to thread data
export { useThreadData } from './use-thread-data'
export type { ThreadDataResult } from './use-thread-data'

export { ConnectionStatusBanner } from './connection-status-banner'

export { ThreadDemo } from './demo'
