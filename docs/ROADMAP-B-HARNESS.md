# Roadmap B — Agentic harness: sessions, streaming, failure, git

Repo: E:\Digitech\softwares\notionharness. Hermes lives at `C:\Users\vaibh\AppData\Local\hermes`. Verify with `npx tsc --noEmit`, `npx eslint <files>`, `npm run build`, then restart on port 3000 and exercise it in a browser. A change to run behaviour is not done until a real run has exercised it.

## Pillar B1 — Session continuity that actually resumes

`chat_sessions.hermes_session_id` is recorded but never used. Hermes's ACP adapter advertises `load_session` and implements both `load_session` and `resume_session` (`acp_adapter/server.py:1158-1170`, `:1456`, `:1504`).

B1.1 Pass the stored ACP session id on the next turn of a session so Hermes replays its own history instead of starting cold.
B1.2 Verify with a three-turn conversation that references turn one without the text being resent. Check the prompt size in the Hermes log stays flat instead of growing.
B1.3 Handle a session id Hermes no longer knows: fall back to a fresh session, record the new id, and say so in the transcript rather than failing the turn.
B1.4 Show context usage per session, from the `usage_update` payload the ACP client already receives.

## Pillar B2 — Failure surfaces that tell the truth

B2.1 Terminal death: when a `terminal/create` child exits unexpectedly mid-turn, surface it as a distinct state on the tool card, not as a generic stall. The exit-code plumbing already exists (`terminal_exit` events, `TerminalBlock` exit rendering).
B2.2 Dispatcher supervision. This is the standing operational gap named in AGENTS.md: the dispatcher is one manually started process, and if it stops every run silently sits queued forever. Add a health signal the UI can see (last tick timestamp) and a loud banner when the dispatcher has not ticked recently. Do not silently start processes.
B2.3 Worktree retention. Per-run disposable worktrees are never removed because the run review screen reads their diffs. Add a real policy: keep the last N per source plus anything referenced by a non-dismissed review, remove the rest, and report what was reclaimed.
B2.4 Re-check the Hermes Git Bash stdin patch on startup and surface it in Settings → Health, not only in the dispatcher log. A `hermes update` silently reverts it and every first tool call hangs again.
B2.5 Approval timeouts: when Hermes's 60s permission window lapses, show that explicitly in the transcript rather than leaving an amber card that never resolves.

## Pillar B3 — Git in the conversation

The project-level worktree view exists. The conversation-level one does not, and that is where the work actually happens.

B3.1 A collapsible git rail in the Work view when the session is bound to a worktree: branch, ahead/behind, changed files, using `lib/git/repo.ts` which already provides all of it.
B3.2 Click a file to see its diff, rendered with the existing `DiffBlock`.
B3.3 Stage, unstage and commit from the rail (`stagePaths`, `unstagePaths`, `commit` already exist). Offer an agent-written commit message as a suggestion the user edits, never as an automatic commit.
B3.4 Push and open a pull request through `gh`, matching how the GitHub binding already works. Confirm before pushing.
B3.5 Poll git state the way Orca does: a shallow 2s stat of `.git` metadata, never a recursive watcher.

## Pillar B4 — Streaming and rendering

B4.1 Measure before changing anything: instrument time from event append to paint for a long turn, and record the numbers.
B4.2 Virtualise the transcript beyond the current 100-message window if measurement justifies it, not before.
B4.3 Tool cards: collapse long output by default with a real line count, and keep the last lines visible rather than the first, because the end is what matters when something fails.
B4.4 Make the reveal buffer respect `prefers-reduced-motion` by painting immediately.

## Pillar B5 — Multi-agent, borrowed from Orca

Orca's orchestration is Run → Task → Dispatch rows in SQLite with a mailbox and decision gates. The equivalent here is cheap because the broker already has runs, leases and events.

B5.1 A session can spawn a child session bound to the same worktree, with the parent's transcript summarised as context.
B5.2 Show parent/child lineage in the session rail as nested rows. Orca is explicit that lineage is a display concern, not git history.
B5.3 A decision gate: a child session that needs approval to continue raises the existing approval mechanism rather than a new one.

## Pillar B6 — Agent detail completeness

B6.1 Sessions tab on the agent detail page: the same rail filtered to that agent (`listSessions` already accepts `agentId`).
B6.2 Show the agent's Hermes profile skills and MCP servers read-only, linking to the settings sections that edit them.
B6.3 Per-agent spend and run counts over 7 and 30 days, from the rollups that already exist.

## Ordering

B1 and B2 first: correctness and honesty before features. B3 next, because git in the conversation is the thing that makes a worktree binding worth having. B4 only after measurement. B5 and B6 last.

## What the competition proves is worth building

Orca's review experience is the bar, and it is mostly UX rather than plumbing.

- **B3.6 Line-anchored diff comments, batched into one prompt.** Hover a diff line, press a key, write a markdown comment pinned to that line and re-anchored as the diff shifts. A single "Send to agent" composes one prompt from every comment, so the agent does one round of thinking and one revision pass instead of a dozen. The comments persist afterwards for verification. This is the single highest-value idea found in any competitor.
- **B3.7 Side-by-side diff with hunk staging and a base-ref picker.** The run review page's own comment admits the unified viewer is a compromise. This is the prerequisite that makes comments feel good.
- **B2.6 Fix broken checks.** A red chip on failed CI that hands the failing job logs to an agent in one click.
- **B6.4 Unread is bold, not a badge.** Pin, archive and sleep as first-class row states on the session rail, with a filter menu that shows how many filters are active.
- **B6.5 A jump palette across sessions and worktrees**, matching on pull request number and title too, where a query with no match offers "create worktree" as a row.
- **B5.4 The mailbox properly.** Orca's orchestration is Run, then a task DAG with dependencies, then dispatch, with group addresses, decision gates and a circuit breaker after three failed dispatches. The Approvals collection is already the gate primitive.

AionUI contributes two things this app currently lacks.

- **B7.1 A stated persistence contract.** Identity fields apply immediately; agent, model, permission, skills and MCP changes apply to new conversations only and are never injected into a running one. The settings screens should say this rather than leaving people guessing.
- **B7.2 Preflight verbs.** Test a connection before saving it, probe a base URL to detect its protocol, and health-check a model. The MCP test button built today is the first of these; the other two are small.

Devin Desktop contributes the planning idea.

- **B8.1 Plan as a document behind an Implement button.** The agent writes its plan into a real page and the run stays deferred until a human clicks Implement. This app already has pages and a deferred dispatcher, so this is wiring rather than invention.
- **B8.2 Session health metering.** Rate a session extra-small through extra-large from turn count, tool calls and wall time, and flag the large ones as unhealthy, alongside the spend caps that already exist.

Two more, cheap and high value.

- **B2.7 Auto-proposed memories.** When a user corrects an agent mid-run, propose that correction as a memory entry into the per-agent memory store built today.
- **B4.5 An interactive terminal.** `lib/terminal/pty-server.ts` is already written and unwired; today the terminal block only renders output. A route plus an xterm client makes it real.
