"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Grows the textarea to fit its content when `autoResize` is enabled.
 * Opt-in only — most textareas in this app still want a fixed, user-resizable box.
 */
function useAutoResize(
  ref: React.Ref<HTMLTextAreaElement> | undefined,
  autoResize: boolean,
  value: unknown
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)

  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement, [])

  React.useEffect(() => {
    if (!autoResize) return
    const node = innerRef.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${node.scrollHeight}px`
  }, [autoResize, value])

  return innerRef
}

function Textarea({
  className,
  autoResize = false,
  ref,
  onChange,
  ...props
}: React.ComponentProps<"textarea"> & {
  /** Grows the textarea to fit its content instead of scrolling. Off by default. */
  autoResize?: boolean
}) {
  const textareaRef = useAutoResize(ref, autoResize, props.value ?? props.defaultValue)

  return (
    <textarea
      ref={textareaRef}
      data-slot="textarea"
      onChange={(event) => {
        if (autoResize) {
          event.currentTarget.style.height = "auto"
          event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`
        }
        onChange?.(event)
      }}
      className={cn(
        "flex min-h-16 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:border-input dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        autoResize && "resize-none overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
