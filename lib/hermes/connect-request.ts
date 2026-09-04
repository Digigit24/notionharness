/**
 * How a parked CONNECT request is told apart from a parked PERMISSION request.
 *
 * Both are the same row in `collections/Approvals.ts` and the same wait in
 * `approval-helpers.ts`, deliberately — the unit brief is explicit that a run
 * must have exactly one way to block, and a second `approvals`-shaped table
 * with its own waiter, its own timeout and its own settle path would be a
 * second way that could only ever drift from the first.
 *
 * What it costs is that the two are indistinguishable downstream, and they do
 * need distinguishing: a permission request is answered by pressing a button,
 * whereas a connect request is answered by going somewhere else entirely and
 * signing in to a third party. So the `externalId` — which is already unique,
 * already carried on every RunEvent, and already what `/api/approvals` is
 * keyed by — names the kind. The alternative considered and rejected was a new
 * column on `approvals`: it would have meant a migration, a change to the raw
 * SQL in `listPendingChannelApprovals`, and a new field on the RunEvent
 * contract, all to carry a fact the id can carry for free.
 *
 * THIS FILE HAS NO IMPORTS AND TOUCHES NOTHING. Both the browser (the card and
 * the channel strip) and the server (the tool that parks and the callback that
 * resolves) have to agree on the shape, and a helper either of them cannot
 * import would become two copies of a string format that silently diverge.
 */

const PREFIX = 'connect'

/**
 * `connect:<connectionId>:<runId>:<nonce>`.
 *
 * The connection id is in there because the callback route, the card's button
 * and the channel strip all need to reach the row that holds the
 * authorisation URL, and it is the only handle any of them has.
 *
 * The nonce is not decoration: `approvals.externalId` is UNIQUE, and one
 * person can be asked to connect the same app twice — abandon the consent
 * screen, let the request time out, have the agent ask again — while
 * `connections` deliberately keeps ONE row per (user, workspace, toolkit). So
 * the connection id alone would collide with the request that timed out, and
 * the second ask would fail at the insert.
 */
export function connectRequestExternalId(connectionId: number, runId: number): string {
  return `${PREFIX}:${connectionId}:${runId}:${Date.now().toString(36)}`
}

/** True when this parked request is an app connection rather than a tool
 * permission — which is what decides whether the transcript and the channel
 * render a Connect affordance or Allow/Deny buttons. */
export function isConnectRequest(externalId: string): boolean {
  return connectionIdFromRequest(externalId) !== null
}

/** The `connections` row this request is waiting on, or null when the id is
 * not a connect request at all. Parsed rather than trusted: this string
 * reaches the server from a browser on the way to a redirect, so anything that
 * is not a plain positive integer in the right position is simply not one. */
export function connectionIdFromRequest(externalId: string): number | null {
  const parts = externalId.split(':')
  if (parts.length !== 4 || parts[0] !== PREFIX) return null
  const connectionId = Number(parts[1])
  return Number.isSafeInteger(connectionId) && connectionId > 0 ? connectionId : null
}

/** The prefix every request for one connection shares, for the callback route
 * that has a connection id and needs to find the request parked on it. */
export function connectRequestPrefix(connectionId: number): string {
  return `${PREFIX}:${connectionId}:`
}
