# Handoff — 2026-09-05

Main is at `e602959`, builds clean, tsc clean, 102/102 vitest, running on :3000.

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

## Pending — start here

1. **Connect-from-chat (R12 phase 2)** — never started; both agents died on the
   session rate limit. Its prerequisite is real: `pendingApprovalWaiters` in
   `lib/hermes/approval-helpers.ts` is an in-process `Map` that only works
   because the dispatcher runs inside Next. Move it onto LISTEN/NOTIFY
   (`lib/broker/notify.ts`) **before** building on it. `test-mention-loop` is
   the proof it still works.
2. **R14-P1.1 message search** — partially built in worktree branch
   `worktree-agent-a9b58c2928cb8be92` (died mid "query wiring and visibility
   gate"). Inspect before continuing; do not restart from scratch.
3. **`resolveConnectorsForRun` has no consumer.** Built and tested; nothing
   injects connectors into a run. Do **not** fold them into `worker.ts`'s
   `sessionConfig` merge — scopes are a union, not most-specific-wins.
4. **`payload_locked_documents_rels` lacks columns** for the five new
   collections. Pre-existing drift, flagged by the lockdown unit.
5. **Nothing has been opened in a browser.** All verification is compile-,
   lint- and database-level. Optimistic rollbacks, disabled-control
   affordances, and every new screen are visually unverified.

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
