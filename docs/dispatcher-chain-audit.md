# Dispatcher / broker / page-write chain audit

Status as of 2026-09-02. “Proven” means observed against the real shared
database/process or a real binary; disposable module tests are called out
separately.

| Link | Status | Evidence / boundary |
| --- | --- | --- |
| Task assignment → broker enqueue | **Proven live earlier** | Gate 3+4 E2E run 28 was created from a real assigned task and reached the broker. `enqueueRun` is also covered by `scripts/test-broker.ts` (11 assertions, rerun live after the prompt migration). Page-scoped `enqueuePageRun` is implemented but not live-called from the UI. |
| Broker claim / token / settle | **Proven live earlier** | Run 28 was claimed, minted a token, completed, and had its token wiped. Runs 38/40 also exercised claim/settle; run 44 timed out and settled `failed`, with retry handling. Lease recovery was proven on run 38 after a restart. |
| Worktree creation | **Proven live earlier** | Run 28 created `agent/run/28` and a disposable worktree, confirmed with `git worktree list`. Run 38 exposed stale-branch recovery; the follow-up fix was verified with `scripts/test-run-worktrees.ts`. |
| Identity-scoped turn | **Proven live earlier** | Run 28 built the HERMES_HOME identity overlay and executed the real `hermes-acp.exe` turn. Existing Hermes ACP smoke tests still pass after lifecycle fixes. |
| Permission handling | **Partially proven live** | Runs 38/40 reached a real ACP permission request and the handler’s safe-deny path. `permission_mode='auto'` selection is implemented in `lib/hermes/acp-client.ts` and forwarded through `run-with-identity.ts`/dispatcher, but no clean live auto-approval has completed yet. `ask` intentionally falls back to deny pending P5.4 approvals. |
| Agent page-write | **Still unverified end-to-end** | The authenticated `POST /api/daemon/page-writes` route and scoped BlockSuite write primitive have disposable tests (`scripts/test-agent-page-writes.ts`, 9 checks), but no successful dispatched run has yet produced a persisted page write. |
| RunEvent streaming / transcript | **Proven live earlier** | Run 28 persisted six ordered events (session, usage, message, usage, done sequence observed); the later runs also persisted monotonic events. The canonical contract is `lib/run-events.ts`, with daemon-assigned sequence envelopes. |
| Settle / retry behavior | **Proven live today** | Run 44 hit the 60-second turn cap, emitted error events, settled `failed`, and automatically produced retry run 45; both were cleaned after verification. Earlier run 38 recovery and the dispatcher robustness fix were also verified live. |
| Review surface diff rendering | **Proven only in disposable fixtures** | `scripts/test-review-surface.ts` exercises changed-file listing, unified diff, worktree state, fast-forward/non-fast-forward merge, and cleanup against temporary repositories. The real dispatched runs tested today (30, 36, 44) produced no file diff: run 30/36 were permission-denied before writing; run 44 timed out before a model call. The `/review` page has therefore not yet rendered a real agent-produced diff. |

## Open gaps

- A clean, live `permission_mode='auto'` run that reaches the model, selects an
  ACP `allow_once` option, writes a file, and leaves a non-empty review diff is
  still outstanding. Attempts 30 and 36 used a live pre-forwarding deployment;
  attempt 44 reached no model call and timed out under upstream load.
- `ask` permission mode remains safe-deny until the P5.4 approval surface wires
  a human decision callback into the ACP handler.
- The page-scoped enqueue action persists `prompt` and `page_id` on raw-pg
  runs, but its caller/agent assignment and a real block-anchored dispatched
  run remain future integration work.
- No claim is made here about pixel-level review UI behavior: the team has no
  browser access; HTTP/module/DB evidence is the available verification level.
