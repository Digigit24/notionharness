// ROADMAP P6.4 — a minimal unified-diff parser for the review surface's
// inline diff viewer. Deliberately hand-rolled rather than a new dependency:
// the brief said "keep it simple," and rendering one file's patch at a time
// (never a multi-file combined diff) only needs hunk headers + +/-/context
// lines, not a general-purpose diff/patch library.
//
// Inline mode was chosen over side-by-side for this first pass — it's the
// faster of the two to render correctly (no column-alignment logic for
// hunks that add/remove different line counts), per the task's explicit
// "don't half-build both."
export type DiffLineType = 'context' | 'add' | 'remove' | 'hunk-header' | 'meta'

export interface DiffLine {
  type: DiffLineType
  oldLineNo: number | null
  newLineNo: number | null
  text: string
}

export interface ParsedFileDiff {
  isBinary: boolean
  lines: DiffLine[]
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const META_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'new file mode',
  'deleted file mode',
  'similarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
]

export function parseUnifiedDiff(patch: string): ParsedFileDiff {
  if (patch.includes('Binary files ') && patch.includes(' differ')) {
    return { isBinary: true, lines: [] }
  }

  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const raw of patch.split('\n')) {
    if (raw === '') continue
    const hunkMatch = HUNK_HEADER_RE.exec(raw)
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1])
      newLine = Number(hunkMatch[2])
      lines.push({ type: 'hunk-header', oldLineNo: null, newLineNo: null, text: raw })
      continue
    }
    if (META_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
      lines.push({ type: 'meta', oldLineNo: null, newLineNo: null, text: raw })
      continue
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      lines.push({ type: 'meta', oldLineNo: null, newLineNo: null, text: raw })
      continue
    }
    if (raw.startsWith('+')) {
      lines.push({ type: 'add', oldLineNo: null, newLineNo: newLine, text: raw.slice(1) })
      newLine += 1
      continue
    }
    if (raw.startsWith('-')) {
      lines.push({ type: 'remove', oldLineNo: oldLine, newLineNo: null, text: raw.slice(1) })
      oldLine += 1
      continue
    }
    // Context line — starts with a leading space in real `git diff` output.
    lines.push({ type: 'context', oldLineNo: oldLine, newLineNo: newLine, text: raw.startsWith(' ') ? raw.slice(1) : raw })
    oldLine += 1
    newLine += 1
  }

  return { isBinary: false, lines }
}
