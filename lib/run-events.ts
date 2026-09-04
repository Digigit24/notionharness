/**
 * Canonical broker/daemon event contract from ROADMAP Pillar 3.1.
 * `seq` and `runId` live on the transport envelope so event payload variants
 * remain identical across storage and wire adapters; the daemon assigns seq.
 */
/** One choice offered by the agent for a permission request. `kind` is ACP's
 * own vocabulary (`allow_once` / `allow_always` / `reject_once` /
 * `reject_always`), which is what decides how the option is presented. */
export interface PermissionOption {
  optionId: string
  kind: string
  label?: string
}

/**
 * How a permission request was answered.
 *
 * Lives in the shared contract rather than in the ACP client because the
 * dispatcher and the approvals layer both need it, and importing it from the
 * client made the runtime package and the core import each other. It is a
 * protocol shape, not a client detail: it mirrors ACP's own `outcome` union
 * and sits naturally beside `PermissionOption`, which describes what was
 * offered.
 */
export type ApprovalOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled'; reason?: string }

export type RunEvent =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; text: string }
  | { type: 'thought'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      input: Record<string, unknown>
      status: string
      /** ACP `ToolCall.locations` — the files/directories the call touches.
       * Hermes leaves `rawInput` empty and puts only the bare pattern in the
       * title (`search: *`), so this is the ONLY place the actual path shows
       * up. Discarding it left tool cards saying `COMMAND: *` for a search of
       * a directory the user had just named. */
      locations?: string[]
      /** ACP `ToolCall.kind` — read/edit/search/execute/… Better than
       * guessing the icon from the tool's display name. */
      kind?: string
    }
  | { type: 'tool_result'; id: string; output: unknown; isError: boolean }
  // A `session/request_permission` from the agent. Emitted TWICE with the
  // same `id`: once when the agent asks (no `outcome`), once when it settles
  // (`outcome` set). The transcript needs both — a request that only appeared
  // and never resolved would leave live buttons on a decision already made.
  | {
      type: 'permission'
      id: string
      title: string
      detail: string
      options: PermissionOption[]
      /** Absent while the request is still open. */
      outcome?: 'selected' | 'cancelled'
      selectedOptionId?: string
      reason?: string
    }
  | { type: 'file_change'; path: string; diff: string }
  | { type: 'terminal'; id: string; chunk: string }
  // The shell behind a `terminal` block exited. Without this, a terminal that
  // simply stopped producing output was indistinguishable from one still
  // running quietly — the transcript could show a live-looking shell for a
  // process that had already died.
  | { type: 'terminal_exit'; id: string; exitCode: number | null; signal: string | null }
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
      kind: 'heading' | 'paragraph' | 'list' | 'code'
      status: 'committed'
    }

export interface RunEventEnvelope {
  runId: string
  seq: number
  event: RunEvent
}
