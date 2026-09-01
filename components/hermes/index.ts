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

export { Marker, TypingIndicator } from './Marker'
export type { MarkerProps, MarkerType } from './Marker'

export { ThreadDemo } from './demo'
