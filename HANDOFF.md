# Handoff — 2026-09-05

Main is at `bdc5173`, builds clean, tsc clean, running on :3000 with the dispatcher loop active. R12-P1 through P4 are now COMPLETE. Only R12-P5 (git/worktree/orchestration hardening) remains, running as of this writing in worktree branch `worktree-agent-ac77f49033d110f0c`.

## Landed this session

**R12-P1 exception spine.** `lib/failures.ts`. Measured, not assumed: a thrown
server action reaches a production browser as `1:E{"digest":…}` with **no
message** — so every carefully-written `throw new Error(...)` in this app had
been showing users a generic React sentence. Actions now RETURN failures via
`guard()`; `unwrap()` throws in the browser where the message survives, so
existing catch-and-toast blocks started telling the truth unedited. 16 error
boundaries where there was 1. `lib/dispatcher/classify-failure.ts` is the retry
taxonomy (cancellation is no longer settled as a failure that enqueues a retry
of the turn you just stopped).

**R12-P2/P3.** Loading states for every route; shimmer primitives; optimistic
send in feed *and* thread with failed rows that keep your text; draggable pane
dividers. Editor split out of two routes: `/teams/[teamId]` and `/p/[pageId]`
both **564 kB → ~193 kB**.

**R12-P4.** `runtime_profiles.defaultSessionConfig` — "Claude's default model"
is one control, merged runtime → agent → per-turn.

**R13-P2.** Formula and rollup engine (`lib/database/`), 47 tests. Empty is not
zero; errors are values, never exceptions; cycles refused at save time.

**Access control.** `workspace-members` (roles), `invitations` (token-keyed),
`access-grants` (polymorphic), `lib/permissions/`. The rule: an agent's
permissions are the **intersection** of its grants and the accountable user's.
Verified 35/35 (invites), 17/17 (grants), 11/11 (unit).

**Composio connectors.** BYOK, `link()` not the deprecated `initiate()`, entity
= our USER not workspace. 20/20. **Live OAuth never exercised — no key on this
machine.**

**Security (Phase 0).** Two of six briefed findings were *wrong as stated* and
the agent said so. Payload's default access is not open — but any authenticated
user in zero workspaces could read/write every collection in every workspace,
demonstrated and closed. 28/28 collections now scoped. `/api/hermes/**` needed
workspace membership, not just a session. MCP `get_page` returned another
workspace's page to a run token — fixed. ~30 server actions had no session
check at all, including `syncPageDoc` (a page id + a Yjs update rewrote any
document in the install).

## Update — 2026-09-05, resumed

**Connect-from-chat: it actually landed.** The agent got further than its
rate-limit error suggested. `pendingApprovalWaiters` IS moved onto a
three-source race (in-process map, Postgres LISTEN/NOTIFY on
`approval_decisions`, a 10s poll fallback); `connect_app(toolkit)` is a real
MCP tool in `app/api/mcp/teams/route.ts`, reusing the approval spine exactly as
briefed; `ConnectCard.tsx` / `connect-strip.tsx` / the callback route all
exist. It was swept into `main` by an earlier "push all uncommitted work"
commit rather than lost. Confirmed with `npx tsc --noEmit` (clean) and
`test-mention-loop.ts` run live end-to-end (mention -> dispatch -> real agent
turn -> reply), which is the specific proof the LISTEN/NOTIFY change did not
break the run path.

**Found and fixed while verifying: the dispatcher was completely dead.** The
Phase 0 lockdown correctly makes `POST /api/dispatcher/tick` refuse with no
`DISPATCHER_SECRET` when `NODE_ENV=production` — but `npm start` is a
production build and no secret had ever been generated, so every run since
that commit landed sat at `status: queued`, `run_token: null` forever. Fixed:
generated `DISPATCHER_SECRET`, added to `.env`, restarted. Both processes
confirmed live: server on :3000, `scripts/run-dispatcher-loop.ts` running and
claiming runs (PID recorded in `.dispatcher-loop.pid`). Commit `59f5222`.

**Still pending, unchanged from before:**

1. **R14-P1.1 message search** — partially built in worktree branch
   `worktree-agent-a9b58c2928cb8be92` (died mid "query wiring and visibility
   gate"). Inspect before continuing; do not restart from scratch.
2. **`resolveConnectorsForRun` has no consumer.** Built and tested; nothing
   injects connectors into a run. Do **not** fold them into `worker.ts`'s
   `sessionConfig` merge — scopes are a union, not most-specific-wins.
3. **`payload_locked_documents_rels` lacks columns** for the five new
   collections. Pre-existing drift, flagged by the lockdown unit.
4. **Nothing has been opened in a browser.** All verification is compile-,
   lint- and database-level. Optimistic rollbacks, disabled-control
   affordances, and every new screen are visually unverified.

## Update 2 — 2026-09-05, R12-P3 and P4.6 completed

**R12-P3 (channel real-time) is now fully done.** The two missing pieces:

- P3.2 typing indicator — `pg_notify` on a dedicated `channel_typing`
  channel, zero rows written. Composer throttles to 1/2s; the room expires a
  signal after 4s with nobody renewing it.
- P3.3 push instead of poll — new SSE route
  `app/api/teams/[teamId]/events/stream`. It carries NO room data, only a
  `refresh` signal that triggers the existing (tested) `pollTeamRoomAction`,
  and a `typing` signal. `POLL_MS` dropped from 6s to a 60s reconciliation
  sweep now that the fast path exists.

Proven against real Postgres NOTIFYs, not by reading the code —
`scripts/test-channel-realtime.ts` opens an actual LISTEN connection and
asserts real notifications arrive for message/reaction/typing/approval-
resolve, that one team's event never reaches another's filter, and that
typing writes zero rows. 8/8. `test-mention-loop` reconfirmed green on the
live server with all four new notify call sites active on the hot path.

**R12-P4.6 (settings hygiene) is now done too.** A search box over the
15-item rail, and `hooks/use-unsaved-changes-guard.ts` wired into the three
settings forms most likely to lose real work (spend cap, runtime defaults,
safety/memory). Caught and fixed a real bug while wiring it: each form
needed its OWN post-save snapshot, not a comparison against the original
server prop, or the guard would stay permanently tripped one save after it
was last accurate.

**So R12 is complete except P5**, which is running as a worktree agent
(`worktree-agent-ac77f49033d110f0c` — check `git branch -a` for the current
name, agent naming may not survive a session boundary). Read its report
before assuming any part of P5 (unified git invocation, worktree crash
survival, the advisory-lock mutex, the chaos script, file-viewer edge cases,
destructive-op confirmations) is done or undone.

## Notes for whoever runs agents next

- Three of four parallel agents were compacted mid-run, re-implemented their own
  files under new names, and reported it as a sibling sabotaging them. Symbol
  greps across transcripts proved otherwise every time. Rule that fixed it:
  **read a file before writing it; if it looks unfamiliar but good, assume you
  wrote it.**
- `npx payload migrate` hangs here. Apply DDL via a tsx script through
  `lib/broker/db.ts`; still write the migration file. `generate:types` works.
- This Postgres caps at 15 connections and the app's pools sum to it — test
  scripts fail with `EMAXCONNSESSION` while the server is up.
