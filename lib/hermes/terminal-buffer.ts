// Bounded tail buffer for ACP terminal output.
//
// The ACP `terminal/create` request carries an optional `outputByteLimit`:
// "Maximum number of output bytes to retain. When the limit is exceeded, the
// Client truncates from the beginning of the output to stay within the
// limit. The Client MUST ensure truncation happens at a character boundary
// to maintain valid string output, even if this means the retained output is
// slightly less than the specified limit." (schema.CreateTerminalRequest,
// `@agentclientprotocol/sdk`). This module implements exactly that contract
// so a runaway shell command (a build loop, a `tail -f`, a hung test runner)
// can't grow a terminal session's buffered output without bound and OOM the
// harness process.
//
// Byte-capped rather than line-capped deliberately: the protocol's own limit
// is byte-denominated (`outputByteLimit`), agent shells routinely emit long
// unbroken lines (progress bars, minified output, base64 blobs) that a
// line-count cap wouldn't bound, and staying byte-for-byte compatible with
// what the agent asked for means we never surprise it with a smaller or
// larger window than it requested.

/**
 * Default cap when the agent's `terminal/create` request omits
 * `outputByteLimit`. 1 MiB comfortably holds a typical build/test log tail
 * while still bounding memory across many concurrent terminal sessions in a
 * long-lived daemon process.
 */
export const DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT = 1024 * 1024

/**
 * Given a UTF-8 byte buffer and a desired tail length, returns the longest
 * suffix that is (a) at most `maxBytes` long and (b) starts on a valid UTF-8
 * sequence boundary — never mid-codepoint.
 *
 * A naive `buf.subarray(buf.length - maxBytes)` can land the cut point on a
 * continuation byte (`10xxxxxx`) in the middle of a multi-byte rune, which
 * corrupts the first character of the retained output (and can throw on
 * strict UTF-8 decoders). This walks forward from the naive cut point until
 * it finds a lead byte (`0xxxxxxx` ASCII, or a `11...` multi-byte lead),
 * which can only drop a few extra bytes — never split a sequence.
 */
export function truncateUtf8Tail(buf: Buffer, maxBytes: number): { data: Buffer; truncated: boolean } {
  if (maxBytes <= 0) return { data: Buffer.alloc(0), truncated: buf.length > 0 }
  if (buf.length <= maxBytes) return { data: buf, truncated: false }

  let start = buf.length - maxBytes
  // Advance past any continuation bytes (top two bits `10`) so `start`
  // lands exactly on the next codepoint's lead byte.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1
  }
  return { data: buf.subarray(start), truncated: true }
}

/**
 * Accumulates a terminal session's output as UTF-8 text, keeping only the
 * most recent `maxBytes` bytes (rune-safe) so a long-lived agent session
 * can't leak unbounded memory into a single terminal's buffer.
 */
export class TerminalBuffer {
  private readonly maxBytes: number
  private data: Buffer = Buffer.alloc(0)
  private truncatedEver = false

  constructor(maxBytes: number = DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT) {
    this.maxBytes = Math.max(1, Math.floor(maxBytes))
  }

  /** Appends a chunk of decoded terminal output and re-bounds the buffer. */
  append(chunk: string): void {
    if (chunk.length === 0) return
    this.data = Buffer.concat([this.data, Buffer.from(chunk, 'utf8')])
    if (this.data.length > this.maxBytes) {
      const { data, truncated } = truncateUtf8Tail(this.data, this.maxBytes)
      this.data = Buffer.from(data) // copy out of the transient concat buffer
      if (truncated) this.truncatedEver = true
    }
  }

  /** Current buffered output, decoded as UTF-8. */
  output(): string {
    return this.data.toString('utf8')
  }

  /**
   * Whether output has ever been dropped from the head of the buffer to
   * stay within `maxBytes`. Sticky: once truncated, stays truncated for the
   * life of the session (matches `TerminalOutputResponse.truncated`, which
   * reports on accumulated history, not just the latest read).
   */
  isTruncated(): boolean {
    return this.truncatedEver
  }
}
