/**
 * A small unified-diff generator, used to turn an agent's `fs/write_text_file`
 * into a `file_change` RunEvent carrying what actually changed.
 *
 * Written rather than pulled in as a dependency because the requirement is
 * narrow (two strings in, one unified diff out — no patch application, no
 * word-level diffing, no directory walking) and this runs inside the
 * dispatcher process, where every added dependency is also added surface on
 * the agent-execution path.
 *
 * The algorithm is the standard LCS dynamic-programming table. That is
 * O(n·m) in lines, which is exactly why `MAX_DIFF_LINES` exists: a
 * pathological write (a minified bundle, a lockfile, a large generated file)
 * would otherwise spend real CPU on a diff nobody will read, on a path that
 * shares a process with live token streaming.
 */

/** Above this, both sides are summarized instead of diffed line-by-line. */
const MAX_DIFF_LINES = 4_000
/** Unified-diff convention: three unchanged lines around each change. */
const CONTEXT_LINES = 3

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  // A trailing newline yields a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = { kind: 'equal' | 'add' | 'del'; text: string }

function diffOps(before: string[], after: string[]): Op[] {
  const n = before.length
  const m = after.length

  // Trim the common prefix and suffix first. Agent edits are almost always
  // localized, so this usually reduces the LCS table to a handful of lines
  // even for a large file.
  let start = 0
  while (start < n && start < m && before[start] === after[start]) start += 1
  let endBefore = n
  let endAfter = m
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }

  const a = before.slice(start, endBefore)
  const b = after.slice(start, endAfter)

  const ops: Op[] = []
  for (let i = 0; i < start; i += 1) ops.push({ kind: 'equal', text: before[i] })

  // LCS table over the reduced middle only.
  const rows = a.length
  const cols = b.length
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', text: a[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i] })
      i += 1
    } else {
      ops.push({ kind: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < rows) ops.push({ kind: 'del', text: a[i++] })
  while (j < cols) ops.push({ kind: 'add', text: b[j++] })

  for (let k = endBefore; k < n; k += 1) ops.push({ kind: 'equal', text: before[k] })
  return ops
}

/**
 * Returns a unified diff, or `null` when the two texts are identical — the
 * caller uses that to skip emitting an event for a no-op write, which agents
 * do often (rewriting a file with the content it already had).
 */
export function unifiedDiff(before: string, after: string, path: string): string | null {
  if (before === after) return null

  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)

  if (beforeLines.length + afterLines.length > MAX_DIFF_LINES) {
    return [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
      `# File too large to diff (${beforeLines.length} → ${afterLines.length} lines).`,
    ].join('\n')
  }

  const ops = diffOps(beforeLines, afterLines)

  // Group the ops into hunks: runs of change plus CONTEXT_LINES of unchanged
  // lines on each side, merged when two changes are close enough to share.
  const changed = ops.map((op) => op.kind !== 'equal')
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (!changed[idx]) continue
    for (let k = Math.max(0, idx - CONTEXT_LINES); k <= Math.min(ops.length - 1, idx + CONTEXT_LINES); k += 1) {
      keep[k] = true
    }
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  let oldNo = 1
  let newNo = 1
  let idx = 0
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].kind !== 'add') oldNo += 1
      if (ops[idx].kind !== 'del') newNo += 1
      idx += 1
      continue
    }
    const hunkOldStart = oldNo
    const hunkNewStart = newNo
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx]
      if (op.kind === 'equal') {
        body.push(` ${op.text}`)
        oldCount += 1
        newCount += 1
        oldNo += 1
        newNo += 1
      } else if (op.kind === 'del') {
        body.push(`-${op.text}`)
        oldCount += 1
        oldNo += 1
      } else {
        body.push(`+${op.text}`)
        newCount += 1
        newNo += 1
      }
      idx += 1
    }
    out.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`)
    out.push(...body)
  }

  return out.join('\n')
}
