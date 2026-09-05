/**
 * The Work hero composer's attachments, turned into text the agent can act on.
 *
 * A run's prompt is a single string handed to the runtime (see
 * `lib/dispatcher/worker.ts`'s prompt builder) — there is no separate
 * "attachments" channel into an ACP turn the way there is into a channel
 * message's `attachments` column. So an attached file's ONLY path to the
 * agent actually noticing it is being named, with a URL it can fetch, inside
 * the prompt text itself. `runs.attachments` (migration
 * `lib/broker/migrations/0017_run_attachments.sql`) remains the durable
 * record of what was attached; this is what makes that record legible to the
 * thing answering the message.
 *
 * Kept as its own pure function, with no import of `getPayloadClient` or
 * anything else server-only, so `scripts/test-run-attachments.ts` can assert
 * its exact output without standing up a database.
 */
export interface PromptAttachment {
  filename: string
  /** Absolute or root-relative — whatever `sendSessionMessage` resolved from
   * the Media doc. Not validated here; this function only renders it. */
  url: string
}

export function formatAttachmentsForPrompt(files: PromptAttachment[]): string {
  if (files.length === 0) return ''
  const lines = files.map((f) => `- ${f.filename} (${f.url})`)
  return `\n\nAttached files:\n${lines.join('\n')}`
}
