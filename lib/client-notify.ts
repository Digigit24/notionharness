/** Small dependency-free client notification surface for async editor actions.
 * Data sources run outside React, so a DOM banner keeps failures visible from
 * Lit and React callers alike without introducing a global provider. */
export function showClientError(message: string): void {
  if (typeof document === 'undefined') return

  const banner = document.createElement('div')
  banner.setAttribute('role', 'alert')
  banner.textContent = message
  Object.assign(banner.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '2147483647',
    maxWidth: 'min(380px, calc(100vw - 40px))',
    padding: '12px 16px',
    borderRadius: '8px',
    background: 'var(--background, #18181b)',
    color: 'var(--foreground, #fafafa)',
    border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 20%)',
    font: '500 14px/1.4 system-ui, sans-serif',
  })
  document.body.appendChild(banner)
  window.setTimeout(() => banner.remove(), 4500)
}
