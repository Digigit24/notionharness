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

## Pillar B9 — Runtime machines: liveness, status, and background start

Host-scoped claiming (`runtime_profiles.host_id`, `lib/broker/runs.ts`'s `claimNextRun`) and the `runtime-hosts` registry (name a machine, one click detects and adds every ACP CLI on its PATH) already ship. Both are claiming discipline: they stop the wrong machine from grabbing work it cannot run. Neither says anything about *state*. This pillar is what closes that gap — three small, additive layers, one that cannot be automated away, and one mode split that falls straight out of data already being workspace-scoped rather than local-only.

B9.1 Per-machine heartbeat. `dispatcher_heartbeat` today is a single row keyed to a fixed id — it answers "is *a* dispatcher alive," never "is *this named machine's* dispatcher alive." Change it to one row per `host_id`, written on every tick alongside the claim call that already knows its own host (`currentHostId()`, `app/api/dispatcher/tick/route.ts`). A machine is "online" if its row updated within the last ~60s. This is the one piece everything below depends on — build it first.

B9.2 Agent and profile status derives from the heartbeat, not new bookkeeping. Once B9.1 exists, a runtime profile's status is a lookup: join `host_id` against the heartbeat table's freshness. An agent bound to that profile inherits it automatically. "Machine B went to sleep → its agents show offline" becomes true with no per-agent state to keep in sync — derive it at read time, the same lesson `workspaces.owner`/`members` already taught this codebase once about storing the same fact twice.

B9.3 A Machines status view. The registry (`runtime-hosts`) already has a name and a host key; add the heartbeat freshness as a column — a green or grey dot, "last seen 3m ago" — on the Machines section already shipped on the Runtimes page. This is the "which is mine, which are others, which are actually up right now" view, sitting entirely on top of B9.1/B9.2 with no new concepts.

B9.4 Easy background start, documented rather than automated. This is an OS-level problem, not an app one, and the one item here with no shortcut: a dispatcher kept alive by a foreground terminal dies the moment that terminal closes or the machine sleeps, and there is no single cross-machine "start everywhere" button possible when each machine is a physically separate computer someone has to configure once. What IS buildable: a guided help page (linked from the Machines section) that documents, per OS, exactly how to run the dispatcher as a background service that survives a closed terminal and restarts on crash or reboot (Windows Task Scheduler / `nssm`, `pm2` elsewhere) — copy-pasteable commands, not just prose — plus, where the OS permission model actually allows a web page to ask for it, a toggle to request the machine stay awake (e.g. the Screen Wake Lock API, which keeps the *display* from sleeping and is the closest a browser can get — it cannot prevent OS-level sleep/hibernate, and the page must say that plainly rather than implying a guarantee it can't back). Ship the documented manual path unconditionally; ship the toggle only where the underlying permission genuinely exists, and never let its absence block the page from being useful.

B9.5 Runtime-only install mode — a machine that lends compute without anyone ever opening a browser on it. Two install modes are genuinely different products, worth naming explicitly: **full** (the Next.js app + dispatcher, someone signs into the UI from this machine) and **runtime-only** (just the dispatcher loop + whatever ACP CLIs are installed, pointed at the same shared database, no Next.js server bound to a port at all). `addMachine` and the dispatcher tick are already decoupled from "a human is looking at this machine's browser" — a runtime-only box needs nothing invented, only a `npm run dispatcher:only`-style entry point that starts the dispatcher loop alone. Add an optional `mode: 'full' | 'runtime-only'` tag on `runtime-hosts`, used purely for labelling ("3 full installs, 2 runtime-only workers") — the behavioural difference is entirely "does anyone use this machine's own UI," not something to gate on.

Explicitly **not** a second signup flow, and not a "machine as a user" model. A runtime-only box's `.env` still needs `DATABASE_URI` and auth secrets, same as a full install (short of building the pairing-code credential handoff already set aside as a bigger, separate thing) — but a machine is never its own account. It runs under the *existing* signed-in user's credentials (or a workspace-scoped service credential later, for tighter blast radius), and gets named, watched, and managed from any full-mode machine's UI, logged in as that same person — because `runtime-hosts` and `runtime-profiles` are already workspace-scoped rows in the shared database, not local-only state, so "manage machine B from machine A's browser" falls out for free rather than needing new plumbing.

**Known limitation, not solved here:** a runtime-only box holds real, unscoped database credentials, identical in blast radius to a full install's — there is no partial-trust story for a machine you don't fully control physically. Scoped, revocable per-machine credentials are a legitimate future need if that ever matters, but not a B9.5 problem.

## Ordering

B1 and B2 first: correctness and honesty before features. B3 next, because git in the conversation is the thing that makes a worktree binding worth having. B4 only after measurement. B5 and B6 last. B9 is independent of B1–B6 (it touches the dispatcher's heartbeat and the Runtimes page, not the Work view) and can start anytime — internally, B9.1 before B9.2 before B9.3, since each is a small layer on the last and none of it touches the claiming logic already shipped; B9.4 can happen first of all, since a heartbeat is only interesting once the process sending it can survive someone closing a terminal. B9.5 is independent of B9.1–B9.4 (it's a startup-script split and a label, not a dependency of the heartbeat work) and can land whenever — pairing it with B9.4's background-start docs is natural since a runtime-only box is exactly the case that most wants to run unattended.

**What not to build for B9:** no polling-based scheme that tries to reach INTO another machine to ask if it's alive — there is no way to contact a machine that isn't the one currently answering requests, and a heartbeat written FROM that machine into the shared database is the only honest signal that exists. No second "status" collection separate from the heartbeat table — derive status at read time from B9.1's freshness, don't store it twice.

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
