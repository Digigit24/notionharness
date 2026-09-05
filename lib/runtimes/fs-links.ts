// Filesystem linking as every home overlay needs it, in one place.
//
// These used to be private to `lib/runtimes/hermes/home-overlay.ts`. The
// generic linked-home strategy (`./linked-home.ts`) builds the same kind of
// overlay for Claude Code, Codex and OpenCode, and copying the helpers would
// have meant two places to get the Windows rules wrong. The rules, confirmed
// on this host rather than assumed (see the Hermes overlay's header for the
// full account): a directory symlink and a file symlink both need elevation,
// a directory junction and a file hardlink do not, and a junction with a
// relative target silently misbehaves — so every target is made absolute
// before linking.
import { link, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function linkDir(target: string, dest: string): Promise<void> {
  await symlink(resolve(target), dest, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Links a file, falling back to a hardlink where a symlink is not permitted.
 *
 * A hardlink behaves identically for in-place writes but — unlike a symlink —
 * goes stale if the target is ever replaced by delete-and-recreate. Recorded
 * in `hardlinkFallbackFor`, never hidden.
 */
export async function linkFile(target: string, dest: string, hardlinkFallbackFor: string[]): Promise<void> {
  const absolute = resolve(target)
  try {
    await symlink(absolute, dest, 'file')
  } catch {
    await link(absolute, dest)
    hardlinkFallbackFor.push(dest)
  }
}

/**
 * `Agents.skills` is an untyped JSON field. A skill pool on disk is one
 * subdirectory per skill name, so a bare string is the only shape usable
 * here; `{ name }` objects are accepted for the same reason the Hermes
 * overlay accepts them.
 */
export function normalizeSkillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry)
    else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name)
    }
  }
  return names
}
