/**
 * Turns a raw run failure into a sentence a person can act on.
 *
 * Every failure in this list is one that actually happened while building
 * this app, and in each case the raw string was technically accurate and
 * practically useless in a chat bubble: `EEXIST: file already exists,
 * mkdir '...\.backup.lock'` says nothing about the agent's home overlay
 * failing to prepare, and a bare `404` says nothing about the configured
 * model no longer existing. The raw text is never discarded — the UI keeps it
 * behind a disclosure — but the headline should be the diagnosis.
 *
 * Deliberately ordered most-specific first: several of these patterns can
 * co-occur in one message (a pool timeout inside a turn timeout, say), and
 * the narrower cause is the more useful headline.
 */
export interface ClassifiedRunError {
  /** One actionable sentence. Never a stack trace. */
  headline: string
  /** Optional next step, when there is a specific one worth naming. */
  hint?: string
  /** The original text, for the Details disclosure. */
  raw: string
}

const RULES: Array<{ test: RegExp; headline: string; hint?: string }> = [
  {
    test: /EEXIST|ENOTEMPTY|\.backup\.lock|home overlay|HERMES_HOME/i,
    headline: 'Agent workspace could not be prepared',
    hint: 'A previous run left its home overlay behind. Retrying usually clears it.',
  },
  {
    test: /\b404\b|model[_\s-]?not[_\s-]?found|unknown model|no such model|invalid model/i,
    headline: 'Model unavailable — check the active provider',
    hint: 'The configured provider/model pair no longer resolves. Update it in Settings → Providers.',
  },
  {
    test: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication/i,
    headline: 'The provider rejected the credentials',
    hint: 'The API key for the active provider is missing, expired, or lacks access to this model.',
  },
  {
    test: /\b429\b|rate.?limit|too many requests|quota/i,
    headline: 'Rate limited by the model provider',
    hint: 'The provider is throttling requests. Waiting and retrying is the fix.',
  },
  {
    test: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection terminated|pool|too many clients|connect\s?timeout/i,
    headline: 'Database unreachable',
    hint: 'The broker could not reach Postgres. The run may have been lost rather than failed.',
  },
  {
    test: /wall-clock|inactivity|no output for/i,
    headline: 'The agent stopped responding mid-turn',
    hint: 'If the very first terminal or file tool call never completes on Windows, Hermes\'s Git Bash probe is deadlocked on the ACP stdin pipe — see AGENTS.md ("Hermes terminal deadlock").',
  },
  {
    test: /timeout|timed out|exceeded.*(time|deadline)/i,
    headline: 'Turn exceeded its time limit',
  },
  {
    test: /cancell?ed|aborted|SIGTERM|SIGKILL/i,
    headline: 'The run was stopped before it finished',
  },
  {
    test: /ENOENT|spawn .* ENOENT|command not found|is not recognized/i,
    headline: 'The agent binary could not be started',
    hint: 'The runtime profile points at a command this machine cannot run.',
  },
  {
    test: /lease|reclaimed|worker/i,
    headline: 'Run was interrupted (worker lost)',
    hint: 'The process running this turn went away — usually a server restart mid-run.',
  },
]

export function classifyRunError(raw: string | undefined | null): ClassifiedRunError | null {
  if (!raw) return null
  const text = String(raw).trim()
  if (!text) return null

  for (const rule of RULES) {
    if (rule.test.test(text)) return { headline: rule.headline, hint: rule.hint, raw: text }
  }

  // No rule matched: fall back to the message's own first line, which is the
  // best available summary, rather than inventing a category for it.
  const firstLine = text.split('\n')[0].trim()
  return { headline: firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine, raw: text }
}

/**
 * True when an assistant "message" is really a failure report the runtime
 * handed back as prose.
 *
 * Hermes surfaces provider failures as ordinary assistant text — `API call
 * failed after 3 retries: HTTP 429: The usage limit has been reached` — so
 * they arrived in the transcript styled exactly like an answer, complete with
 * a copy button, and read as though the agent had replied. Several of these
 * sat in the history looking like legitimate responses.
 *
 * Deliberately strict, because a false positive would restyle a genuine
 * answer that merely discusses an error: the text must be SHORT (a real reply
 * explaining an HTTP status is prose, this is a one-line report) and must
 * match a whole-string shape, never merely contain a keyword.
 */
const AGENT_ERROR_SHAPES = [
  /^API call failed\b/i,
  /^Error:\s/i,
  /^Request failed\b/i,
  /^HTTP \d{3}\b/i,
  /^\w[\w .'-]{0,40}: HTTP \d{3}\b/i,
]

/** Above this many characters it is prose, not a status line. */
const MAX_AGENT_ERROR_CHARS = 300

export function looksLikeAgentError(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_AGENT_ERROR_CHARS) return false
  // A multi-paragraph answer is an answer, whatever it starts with.
  if (trimmed.split(String.fromCharCode(10)).filter((line) => line.trim()).length > 3) return false
  return AGENT_ERROR_SHAPES.some((shape) => shape.test(trimmed))
}
