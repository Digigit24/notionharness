/**
 * Canonical broker/daemon event contract from ROADMAP Pillar 3.1.
 * `seq` and `runId` live on the transport envelope so event payload variants
 * remain identical across storage and wire adapters; the daemon assigns seq.
 */
export type RunEvent =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; status: string }
  | { type: 'tool_result'; id: string; output: unknown; isError: boolean }
  | { type: 'permission'; id: string; title: string; detail: string; options: string[] }
  | { type: 'file_change'; path: string; diff: string }
  | { type: 'terminal'; id: string; chunk: string }
  | { type: 'usage'; provider: string; model: string; tokens: number; costTicks: number }
  | { type: 'session'; externalId: string }
  | { type: 'done'; status: 'ok' | 'error' | 'cancelled'; reason?: string }
  // ROADMAP 6.1 — a post-persist confirmation that a block landed in the
  // run's page subtree (`lib/agent-page-writes.ts` already did the actual
  // Yjs write by the time this is recorded). Deliberately a *committed*
  // fact, not an upstream intent/trigger — the daemon's request to write is
  // a plain HTTP call to `/api/daemon/page-writes`, never this event, so
  // there's no risk of a "committed" record being replayed as a new write.
  | {
      type: 'page_write'
      pageId: number
      subtree: string
      blockId: string
      operation: 'append'
      kind: 'heading' | 'paragraph'
      status: 'committed'
    }

export interface RunEventEnvelope {
  runId: string
  seq: number
  event: RunEvent
}
