'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Client-side reveal buffer for the one text block that is still streaming.
 *
 * Delivery is already as fast as it can be (live bus → SSE → adapter); the
 * problem was purely visual. Hermes emits assistant text in uneven chunks —
 * a few characters, then a 600-character burst — and painting each chunk the
 * instant it lands made replies jump-cut. This queues incoming text and drains
 * it onto the screen at a capped rate on requestAnimationFrame: a big burst is
 * spread over a couple of hundred milliseconds, while a genuinely fine-grained
 * chunk still lands within a frame or two.
 *
 * Never adds latency to the pipeline: it only decides how much of what has
 * ALREADY arrived is painted this frame, and it snaps to the full text the
 * moment the block stops streaming (`active` false) so nothing is ever held
 * back after a turn ends.
 *
 * Rate: each frame reveals at least `MIN_CHARS_PER_FRAME` characters and at
 * most a `1/DRAIN_FRAMES` share of the backlog, so the tail of a burst always
 * finishes in roughly `DRAIN_FRAMES` frames regardless of size.
 */
const MIN_CHARS_PER_FRAME = 12
const DRAIN_FRAMES = 8

/**
 * True when the viewer has asked their system for less animation.
 *
 * This buffer is smoothing, and smoothing is animation: text sliding in a few
 * characters at a time is exactly the kind of motion someone with vestibular
 * sensitivity turns that setting on to avoid. Under the preference the buffer
 * becomes a no-op and text paints the instant it arrives, which is also the
 * lower-latency behaviour — the one place in this codebase where the
 * accessible choice and the fast choice are the same choice.
 *
 * Read live rather than once, because the preference can change while the page
 * is open (a laptop switching to battery saver does exactly this).
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    // `matchMedia` is absent during SSR and in some test environments; its
    // absence means "no stated preference", not "prefers motion".
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function useRevealedText(text: string, streaming: boolean): string {
  const reducedMotion = useReducedMotion()
  const active = streaming && !reducedMotion
  const [shown, setShown] = useState(active ? 0 : text.length)
  const shownRef = useRef(shown)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      shownRef.current = text.length
      setShown(text.length)
      return
    }
    // Text got shorter (a new block reused this component): start over.
    if (shownRef.current > text.length) {
      shownRef.current = 0
      setShown(0)
    }
    if (frame.current != null) return

    const step = () => {
      frame.current = null
      const remaining = text.length - shownRef.current
      if (remaining <= 0) return
      const reveal = Math.max(MIN_CHARS_PER_FRAME, Math.ceil(remaining / DRAIN_FRAMES))
      shownRef.current = Math.min(text.length, shownRef.current + reveal)
      setShown(shownRef.current)
      if (shownRef.current < text.length) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => {
      if (frame.current != null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
  }, [text, active])

  return active ? text.slice(0, shown) : text
}

export function StreamingText({ text, active }: { text: string; active: boolean }) {
  const revealed = useRevealedText(text, active)
  return <>{revealed}</>
}
