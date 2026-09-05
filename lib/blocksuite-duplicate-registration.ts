'use client'

/**
 * A standalone diagnostic for one specific failure: `BlockSuiteEditor.tsx`'s
 * custom elements getting registered more than once because that component
 * has five separate import sites and webpack is free to split each into its
 * own chunk (see `ensureBlockSuiteEffects`'s own long comment in that file
 * for the full mechanism, and its `window`-scoped singleton for the actual
 * fix).
 *
 * This file exists for the case that fix does not cover: some OTHER, not yet
 * discovered path calling `customElements.define` a second time for a
 * BlockSuite tag — a future editor extension added outside
 * `ensureBlockSuiteEffects`, for instance. Without this, that failure shows
 * up as `TypeError: Failed to construct 'HTMLElement': Illegal constructor`,
 * thrown from deep inside Lit's own render path with a stack trace that
 * names none of this app's own files — exactly what made the ORIGINAL
 * occurrence of this bug take this long to diagnose. This turns that same
 * error into a message that names the actual mechanism on sight.
 *
 * Deliberately does NOT reload the page (unlike `stale-build-notice.tsx`,
 * which used to also match this pattern — see its own comment on why that
 * was removed): a reload happens to clear the corrupted custom-elements
 * registry, which makes the symptom disappear without anyone learning a real
 * bug was there. This is meant to be seen, not silently worked around.
 */
const ILLEGAL_CONSTRUCTOR = /Failed to construct 'HTMLElement':\s*Illegal constructor/i

function explain(text: string) {
  console.error(
    '[blocksuite-duplicate-registration] Caught: "%s"\n\n' +
      'This is BlockSuite custom elements being registered more than once in this tab. ' +
      'A tag can only be defined once per document — the SECOND customElements.define() call for ' +
      'the same tag throws and aborts whatever effects() function was mid-registration, silently ' +
      'leaving every element type listed AFTER the failing line unregistered. Constructing one of ' +
      'those later throws this exact error, often minutes afterward and from code that looks ' +
      'completely unrelated to registration.\n\n' +
      'The known cause (components/editor/BlockSuiteEditor.tsx) is already guarded with a ' +
      'window-scoped singleton — if you are seeing this, either that guard was bypassed, or a ' +
      'DIFFERENT code path is calling customElements.define for a BlockSuite tag outside it. ' +
      'Search this codebase for other `effects()` calls or direct `customElements.define` calls ' +
      'to find it.',
    text,
  )
}

function looksLikeIt(value: unknown): string | null {
  const text =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'message' in value
          ? String((value as { message: unknown }).message)
          : ''
  return text && ILLEGAL_CONSTRUCTOR.test(text) ? text : null
}

let installed = false

/** Idempotent — safe to call from more than one mounted component (the same
 * chunk-splitting this diagnoses could duplicate the CALLER too). */
export function watchForDuplicateBlockSuiteRegistration() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (event) => {
    const text = looksLikeIt(event.error) || looksLikeIt(event.message)
    if (text) explain(text)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const text = looksLikeIt(event.reason)
    if (text) explain(text)
  })
}
