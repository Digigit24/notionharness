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
  | { type: 'done'; status: 'ok' | 'error' | 'cancelled' }

export interface RunEventEnvelope {
  runId: string
  seq: number
  event: RunEvent
}
