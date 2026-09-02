// B0: Frame — tiny event bus so anything in the app (today: the sidebar's
// Cmd+K hint button) can ask the command bar to open without lifting its
// open/closed state out of the component that owns it.
//
// `components/command-bar/command-bar.tsx` owns the Cmd+K hotkey itself
// (its own `keydown` listener — see that file's header comment) and is the
// only thing that ever sets its own open state; this event is the one
// sanctioned way for anything else to *ask* it to open, so future callers
// (a breadcrumb "Jump to..." button, a future keyboard-shortcut registry
// entry, etc.) don't need a prop passed down through the tree.
export const COMMAND_BAR_OPEN_EVENT = 'notionforge:open-command-bar'

export function openCommandBar() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(COMMAND_BAR_OPEN_EVENT))
}
