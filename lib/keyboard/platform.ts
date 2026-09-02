'use client'

/**
 * Best-effort Mac detection for display purposes only (choosing "⌘" vs
 * "Ctrl" in the cheat sheet). Never used for behavior — `comboFromEvent` in
 * registry.ts already treats `metaKey` and `ctrlKey` as interchangeable via
 * the `mod` alias, so shortcuts work identically on every platform
 * regardless of what this returns.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platform = uaData?.platform ?? navigator.platform ?? ''
  return /mac/i.test(platform)
}
