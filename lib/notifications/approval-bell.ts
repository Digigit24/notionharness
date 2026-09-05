'use client'

// The chime that says "an agent is waiting on you".
//
// Push notifications reach a person who has left; this reaches a person who
// is here, in another tab of the app or looking at a different page, and
// would otherwise find out twelve seconds late from a number in the sidebar
// that they were not looking at. It plays for approvals only — a decision
// or a permission an agent cannot proceed without — because that is the one
// event where a delay costs a blocked run, and a chime for everything is a
// chime for nothing.
//
// Synthesised with the Web Audio API rather than shipped as a file: no
// asset to host, nothing the CSP has to allow, and two sine tones with an
// envelope are a nicer bell than most sample files anyway. Browser autoplay
// policy means an AudioContext only produces sound after the page has seen
// a user gesture; `installAudioUnlock` arms it on the first click or key so
// a later chime is not silently blocked.
//
// Nothing here imports from `node:` — it runs in the browser bundle.

let context: AudioContext | null = null
let unlockInstalled = false

type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext }

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (context) return context
  const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext
  if (!Ctor) return null
  try {
    context = new Ctor()
  } catch {
    return null
  }
  return context
}

/**
 * Arms audio on the first user gesture, once per page. Safe to call many
 * times; safe to call on the server (no-op).
 */
export function installAudioUnlock(): void {
  if (typeof window === 'undefined' || unlockInstalled) return
  unlockInstalled = true
  const unlock = () => {
    const ctx = getContext()
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('keydown', unlock, { passive: true })
}

/**
 * Plays the chime. Resolves to false when the browser cannot or will not
 * make a sound right now (no Web Audio, or no user gesture yet), so a
 * caller can say so instead of assuming it rang.
 */
export async function playApprovalBell(): Promise<boolean> {
  const ctx = getContext()
  if (!ctx) return false
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return false
    }
  }
  if (ctx.state !== 'running') return false

  const master = ctx.createGain()
  master.gain.value = 0.6
  master.connect(ctx.destination)

  const tone = (frequency: number, start: number, duration: number, peak: number) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = frequency
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peak, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    osc.connect(gain)
    gain.connect(master)
    osc.start(start)
    osc.stop(start + duration + 0.05)
  }

  // A5 then E6: a rising two-note bell, short enough not to be a nag.
  const now = ctx.currentTime
  tone(880, now, 0.42, 0.28)
  tone(1318.51, now + 0.13, 0.55, 0.22)
  return true
}

/**
 * Whether a new approval appeared between two polls.
 *
 * The id is the honest signal: a count can hold steady while one request is
 * settled and another arrives, and it can rise when a page reloads. A higher
 * highest-id than last time means a request that did not exist before. The
 * count is the fallback for a status that carries no id.
 */
export function shouldRingForApprovals(
  previous: { latestApprovalId: number | null; approvalsWaiting: number },
  next: { latestApprovalId: number | null; approvalsWaiting: number },
): boolean {
  if (next.latestApprovalId !== null && previous.latestApprovalId !== null) {
    return next.latestApprovalId > previous.latestApprovalId
  }
  if (next.latestApprovalId !== null && previous.latestApprovalId === null) {
    // The first approval ever seen by this page, or the first since a
    // period with none. Either way, it is new.
    return next.approvalsWaiting > 0
  }
  return next.approvalsWaiting > previous.approvalsWaiting
}

/** Fired on `window` when the person changes the preference on the settings
 * page, so an already-mounted shell honours it without a reload. */
export const APPROVAL_BELL_PREFERENCE_EVENT = 'nf:approval-bell-preference'

export function broadcastApprovalBellPreference(enabled: boolean): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(APPROVAL_BELL_PREFERENCE_EVENT, { detail: { enabled } }))
}
