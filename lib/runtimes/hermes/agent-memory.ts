// Per-agent memory, read and written directly on disk in Hermes's own format.
//
// WHY DIRECT FILESYSTEM ACCESS, and not the dashboard API: memory is the one
// piece of Hermes state this app owns rather than shares. `home-overlay.ts`
// gives every agent its own persistent `memories/` directory
// (`~/.notionforge/hermes/agent-memories/<agentId>/`) and junctions it into
// that run's disposable HERMES_HOME, precisely so two agents on the same
// profile do not share notes. Hermes's own `/api/memory` is profile-scoped
// and, in any case, exposes only the provider name and file byte sizes — it
// has no endpoint that reads or writes entry content (verified against
// `web_server.py:13101`). So the profile-keyed HTTP proxy this replaces could
// never have worked: it asked a server that has no such route, keyed by the
// agent's display name, for a store that is keyed by numeric agent id. That
// is the "Failed to load memories" error, and it was never a transient one.
//
// FORMAT, taken from Hermes's own memory tool (`tools/memory_tool.py`):
//   - two files per agent: `MEMORY.md` (the agent's notes) and `USER.md`
//     (who the user is), both read at `MemoryStore` construction (:223-224)
//   - entries within a file are separated by `ENTRY_DELIMITER = "\n§\n"`
//     (:67) — NOT by blank lines, so an entry may itself contain paragraphs
// Writing in the same format is what makes an edit here visible to the agent
// on its next turn, and an agent's own `memory(add=...)` visible here.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Hermes's entry separator. Keep in lockstep with `memory_tool.ENTRY_DELIMITER`. */
const ENTRY_DELIMITER = '\n§\n'

export type MemoryTarget = 'memory' | 'user'

const FILE_FOR_TARGET: Record<MemoryTarget, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
}

export interface MemoryEntry {
  /** Position in the file. Stable only until the next write, which is why
   * every mutation below takes the full list rather than an id. */
  index: number
  text: string
}

export interface AgentMemoryFile {
  target: MemoryTarget
  fileName: string
  path: string
  entries: MemoryEntry[]
  /** Bytes on disk, so the UI can show how close this is to Hermes's
   * `memory.memory_char_limit` without us duplicating that config. */
  bytes: number
  exists: boolean
}

export interface AgentMemory {
  agentId: number
  dir: string
  memory: AgentMemoryFile
  user: AgentMemoryFile
}

/** Same default as `home-overlay.ts` — one root, two readers. */
function agentMemoryRoot(): string {
  return process.env.HERMES_AGENT_MEMORY_ROOT || join(homedir(), '.notionforge', 'hermes', 'agent-memories')
}

export function agentMemoryDir(agentId: number): string {
  if (!Number.isSafeInteger(agentId) || agentId < 1) {
    throw new Error(`Invalid agent id ${JSON.stringify(agentId)}.`)
  }
  return join(agentMemoryRoot(), String(agentId))
}

function parseEntries(raw: string): MemoryEntry[] {
  if (!raw.trim()) return []
  return raw
    .split(ENTRY_DELIMITER)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text, index) => ({ index, text }))
}

function serializeEntries(entries: string[]): string {
  const cleaned = entries.map((text) => text.trim()).filter((text) => text.length > 0)
  return cleaned.length ? `${cleaned.join(ENTRY_DELIMITER)}\n` : ''
}

async function readFileEntries(dir: string, target: MemoryTarget): Promise<AgentMemoryFile> {
  const fileName = FILE_FOR_TARGET[target]
  const path = join(dir, fileName)
  try {
    const [raw, stats] = await Promise.all([readFile(path, 'utf-8'), stat(path)])
    return { target, fileName, path, entries: parseEntries(raw), bytes: stats.size, exists: true }
  } catch {
    // A never-written memory file is the normal state for a new agent, not an
    // error — the old UI reported it as one.
    return { target, fileName, path, entries: [], bytes: 0, exists: false }
  }
}

export async function readAgentMemory(agentId: number): Promise<AgentMemory> {
  const dir = agentMemoryDir(agentId)
  const [memory, user] = await Promise.all([readFileEntries(dir, 'memory'), readFileEntries(dir, 'user')])
  return { agentId, dir, memory, user }
}

/**
 * Replaces one memory file's entries wholesale.
 *
 * Written to a temp file and renamed, because the agent may be mid-turn: a
 * partial read of a half-written MEMORY.md goes straight into its system
 * prompt (Hermes freezes a snapshot at session start), and a torn file there
 * is worse than a stale one. `rename` is atomic within a directory.
 */
export async function writeAgentMemory(
  agentId: number,
  target: MemoryTarget,
  entries: string[],
): Promise<AgentMemoryFile> {
  const dir = agentMemoryDir(agentId)
  await mkdir(dir, { recursive: true })
  const fileName = FILE_FOR_TARGET[target]
  const path = join(dir, fileName)
  const tmp = join(dir, `.${fileName}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, serializeEntries(entries), { encoding: 'utf-8', mode: 0o600 })
  await rename(tmp, path)
  return readFileEntries(dir, target)
}

/** Convenience wrappers the server actions use, each a full-list rewrite so
 * concurrent edits cannot interleave into a corrupt file. */
export async function addAgentMemoryEntry(
  agentId: number,
  target: MemoryTarget,
  text: string,
): Promise<AgentMemoryFile> {
  const current = await readAgentMemory(agentId)
  const file = target === 'memory' ? current.memory : current.user
  return writeAgentMemory(agentId, target, [...file.entries.map((e) => e.text), text])
}

export async function updateAgentMemoryEntry(
  agentId: number,
  target: MemoryTarget,
  index: number,
  text: string,
): Promise<AgentMemoryFile> {
  const current = await readAgentMemory(agentId)
  const file = target === 'memory' ? current.memory : current.user
  const next = file.entries.map((entry) => entry.text)
  if (index < 0 || index >= next.length) throw new Error('That memory entry no longer exists.')
  next[index] = text
  return writeAgentMemory(agentId, target, next)
}

export async function deleteAgentMemoryEntry(
  agentId: number,
  target: MemoryTarget,
  index: number,
): Promise<AgentMemoryFile> {
  const current = await readAgentMemory(agentId)
  const file = target === 'memory' ? current.memory : current.user
  const next = file.entries.map((entry) => entry.text).filter((_, i) => i !== index)
  return writeAgentMemory(agentId, target, next)
}
