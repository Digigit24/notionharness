# Roadmap series — from a Hermes app to an agent harness

Supersedes `ROADMAP-A-PAGES.md` (mostly delivered) and `ROADMAP-B-HARNESS.md`
(folded in below). Seven roadmaps, ordered so that each one makes the next
cheaper rather than harder.

---

## D0 — Latency is the first priority, and it outranks every other decision here

This rule comes before the five decisions below and overrides them where they
conflict. If a feature is only achievable by making the app slower, the
feature is wrong, not the budget.

**What it forbids, concretely.**

- **No CRDT on a streaming path.** A high-frequency append-only log must never
  live in a Yjs document. Every token would become a document update and a
  persistence write. This is why the team channel feed is a virtualised list
  over the typed `RunEvent` stream, and why BlockSuite is used for the
  channel's durable canvas only.
- **No round trip on the send path.** Pressing Enter paints immediately.
  Anything the server has to confirm is confirmed after the paint, never
  before it. The composer already works this way and must stay that way.
- **No N queries where one will do**, and no sequential awaits in a server
  component that could be one `Promise.all`.
- **No polling where a push already exists.** The broker has LISTEN/NOTIFY and
  SSE. A new interval is a design failure unless the thing being watched is
  genuinely outside the database.
- **No blocking a first render on an external process.** Spawning or waking a
  CLI, a dashboard server or a provider API must happen off the render path,
  with the UI stating that it is warming rather than sitting blank.
- **No unbounded lists.** Transcripts, feeds, boards and terminals all cap and
  virtualise. Growth is a product requirement, not an excuse.

**What it requires.**

- **Measure before adding, not only before optimising.** A feature that adds a
  query, a fetch or a subscription states its cost in the pull request.
- **Degrade visibly rather than wait silently.** A slow dependency shows a
  warming or stale state; it never holds the page.
- **Cache what is stable, never what is live.** Config and capability reads
  are cacheable. Run state is not.

**Known latency debt to pay down, carried openly rather than forgotten.**

- `getSidebarPages` adds a second query on every workspace layout render to
  exclude task documents. Fold it into the existing page read.
- `readConfigSubset` fetches the entire config from the runtime and projects
  it down. Correct for safety, wasteful per settings render. Cache per profile
  and invalidate on write.
- The runtime dashboard server cold-starts in roughly three seconds on the
  first settings visit. Warm it in the background on workspace load, and show
  a warming state rather than an empty panel.
- The Work session rail refreshes on a five second interval while a turn runs.
  It should ride the existing event stream instead.
- The assistant text reveal buffer intentionally spreads a large chunk over a
  few frames. It never delays delivery and snaps to full text the moment a
  turn ends, but it is the one place smoothness was chosen over instant paint.
  Keep it bounded, and make it a no-op under reduced motion.

## The five decisions this series rests on

**D1. ACP is the interface. There are no adapter classes.**
Adding a CLI is data — a command, arguments, environment — not code. This is
confirmed twice over. Our own ACP client is already ~95% runtime-neutral, with
Hermes leaking only through a docstring and two normalisations. And AionUi,
which supports Claude Code, Codex, Qwen, Gemini, Cursor, OpenCode and Goose,
has no `AgentBase`, no `IAgent`, no adapter registry: every one of those is
`kind: 'acp'` distinguished by a free-text label, with exactly two
backend-name special cases in the whole client. The abstraction IS the
protocol.

**D2. Capabilities are declared by the agent, never by a matrix we maintain.**
The ACP `initialize` response carries agent capabilities, auth methods, config
options, modes, models and commands. Store it verbatim as an opaque handshake
record and derive flags from it. Crucially, unknown must stay a third state:
AionUi's `getSupportedMcpTransports()` returns `undefined` before a handshake
rather than `false`, and that tri-state is the right call. A UI that hides a
control because it has not asked yet is lying.

**D3. A personality is our data, not the runtime's.**
Instructions, memory, enabled skills and a model preference. All four live in
our database and are portable across runtimes. Each runtime then materialises
them however it can. We already built the mechanism without naming it: the
per-run home overlay makes a disposable agent home, links in that agent's own
memories and skills, and points the process at it through an environment
variable. Claude Code and Codex both have their own home-directory
conventions, so this generalises to a per-runtime strategy rather than a
rewrite. A Hermes profile becomes an optional accelerator — use it as the
overlay's base when chosen, build from our own data when not.

**D4. Two levels of MCP and skills, and the boundary is ownership.**
*Runtime level* is whatever the CLI already has configured. We mirror it, we
can toggle it, we never own it. *Plugin level* is ours: it lives in our
database, carries permissions and team access, and is injected per run.
Composio belongs at the plugin level precisely because it needs per-user
connected accounts and permission scoping that a CLI config file cannot
express. Runtime level is a mirror; plugin level is state.

**D5. Copy AionUi's contract, not its plumbing.**
Worth taking: ACP as the sole interface, handshake-declared capabilities,
self-describing config options, stable machine-readable error codes, a mailbox
with explicit addressing, a dependency-graph task board, and gating team
warmup on the leader alone. Not worth taking: PATH-based detection (we are a
server, not a laptop), team tools injected over stdio MCP (co-located
processes only), `localStorage` as the state store, an untyped `{type, data}`
stream envelope, and single-host leases. We have a Postgres broker; their
model does not survive a second worker.

---

## R1 — Runtime core: make the harness runtime-neutral

Do this first. Adding a second runtime and generalising afterwards is the
version that hurts, because four things currently assume a Hermes filesystem:
the overlay base, profile resolution, the dashboard server, and provider
config editing.

- **R1.1 Break the latent import cycle first.** `worker.ts` imports the
  `ApprovalOutcome` type from `acp-client`. Move it into `lib/run-events.ts`
  or the runtime package and the core will import each other.
- **R1.2 Move twelve files into `lib/runtimes/hermes/`**: `home-overlay`,
  `run-with-identity`, `profiles`, `providers`, `personas`,
  `serve-supervisor`, `serve-client`, `agent-memory`, `install-checks`,
  `ping`, `mcp-catalog`, `runtime-health`, plus `lib/hermes-api.ts` and
  `globals/HermesConfig.ts`.
- **R1.3 Keep the core where it is**: `acp-client`, `terminal-buffer`,
  `unified-diff`, `spawn-env`, `runEvent-adapter`, `classify-run-error`,
  `run-events`. Leave `approval-helpers` in core and pass a callback down —
  it reaches into Payload, and a runtime package that does so inverts the
  dependency.
- **R1.4 Rename `components/hermes/` to `components/thread/`.** All 24
  components render our `RunEvent` contract and contain nothing Hermes.
- **R1.5 Audit client bundles.** Several `'use client'` components import
  `lib/hermes/providers`. If any is a value import rather than type-only, the
  move will surface an existing bundling problem. Find out before moving.
- **R1.6 Capture the handshake.** Store `agent_capabilities`, `auth_methods`,
  `config_options`, `available_modes`, `available_models`,
  `available_commands` verbatim on the runtime profile. Derive flags; never
  hardcode a matrix.
- **R1.7 Two-step detection with stable error codes.** Step one, does the
  binary exist. Step two, does it complete an ACP `initialize` in a temp
  directory. These are different failures with different fixes, so report
  them differently: `command_not_found`, `acp_init_failed`, `auth_required`,
  `version_drift`. Codes, not translated strings. Give the probe a timeout —
  AionUi's own docs admit theirs hangs forever if the CLI hangs.
- **R1.8 Fix the seeder.** `seed-starter-workspace` hardcodes the Hermes
  binary path, so seeding silently produces a Hermes-only runtime profile.
- **R1.9 Generalise ping** away from Hermes's `--check` flag to the ACP
  handshake probe from R1.7.

**Done when** a second ACP CLI can be registered from the UI, pass detection,
and complete a turn, with no code changes.

---

## R2 — Portable identity: personalities without Hermes profiles

- **R2.1 Personality becomes a first-class record**: instructions, memory
  store, enabled skills, model preference. Per agent, runtime-neutral.
- **R2.2 Generalise the home overlay into a runtime home materialiser.** Same
  linking logic, per-runtime environment variable name and file layout. A
  runtime with no home concept returns a no-op and the personality degrades to
  a prompt prefix, which is honest rather than broken.
- **R2.3 Hermes profile becomes optional.** Selected, it is the overlay base
  and brings its credentials and config. Unselected, the home is built from
  our own data. Both paths already exist; one is currently mandatory.
- **R2.4 Memory is already ours** and already portable — it is our directory
  in Hermes's file format. Keep the format, drop the assumption.
- **R2.5 Model selection is capability-gated.** Hermes reads config, Claude
  takes a flag, a bare ACP agent may offer nothing. Hide the control when the
  handshake says there is nothing to choose.

**Done when** an agent on a non-Hermes runtime has instructions, memory and
skills that behave the same way.

---

## R3 — Correctness: resume, failure, and the truth

Folded from the old B1, B2 and B4.

- **R3.1 Session resume.** The ACP session id is currently **write-only** — we
  store it on every session and nothing ever reads it back. So this is
  unbuilt, not half-built. Pass it on the next turn so the agent replays its
  own history. Prove it with a three-turn conversation referencing turn one
  where the prompt size stays flat. Handle a session id the agent has
  forgotten by starting fresh, recording the new id, and saying so in the
  transcript.
- **R3.2 Terminal death** as its own state on the tool card, not a generic
  stall. The exit-code plumbing already exists.
- **R3.3 Dispatcher supervision.** It is one manually started process; if it
  stops, every run sits queued forever with no signal. Surface last-tick time
  and warn loudly. Do not silently start processes.
- **R3.4 Worktree retention.** Per-run checkouts are never removed because the
  review screen reads their diffs. Keep the last N per source plus anything a
  live review references; report what was reclaimed.
- **R3.5 Heartbeats, which AionUi does not have.** Their "silent agents
  auto-escalate to failed" is a readme claim; in code there is only a slow-turn
  flag. A wedged CLI holding an open pipe is exactly our observed failure mode,
  so detect it explicitly.
- **R3.6 Approval timeouts** that resolve visibly instead of an amber card that
  never settles.
- **R3.7 Streaming: measure before changing.** Time from event append to paint
  on a long turn. Virtualise beyond the current hundred-message window only if
  the numbers justify it. Respect reduced motion.
- **R3.8 Redact secrets in agent error text** before it reaches a log or the
  UI. AionUi does this and almost nobody does.

---

## R4 — The plugin layer: our MCP, our skills, our connectors

This is the prerequisite for teams, because team tools ride on it.

- **R4.1 Plugin registry.** Our own MCP servers and skills as database records
  with permissions and team access, injected per run. Everything optional,
  nothing implicit.
- **R4.2 Serve team and plugin tools over HTTP or SSE, not stdio.** AionUi
  gates team membership on `mcpCapabilities.stdio` because their processes are
  co-located. Ours are not, and that gate would be simply wrong for us. Their
  own capability type already carries `http` and `sse` flags they do not
  exploit.
- **R4.3 Runtime-level mirror.** Read and toggle whatever the CLI already has.
  Never write ownership into it.
- **R4.4 Composio at the plugin level** for connectors, with per-user
  connected accounts.
- **R4.5 Self-describing config options.** `{id, type: select | boolean |
  string, options}` rendered by one generic component, so a new runtime's
  settings need no new screen.

---

## R5 — Git review, the part Orca does best

Folded from the old B3, plus what is still missing.

- **R5.1 A git rail in the conversation** when the session is bound to a
  worktree: branch, ahead and behind, changed files. `lib/git/repo.ts` already
  provides all of it.
- **R5.2 Side-by-side diff with hunk staging and a base-ref picker.** The run
  review page's own comment admits the unified viewer is a compromise.
- **R5.3 Line-anchored diff comments batched into one prompt.** The single
  best idea found in any competitor. Comment on several lines, press send
  once, and the agent does one round of thinking and one revision pass instead
  of a dozen. Comments persist afterwards for verification.
- **R5.4 Stage, unstage, commit** with an agent-suggested message the human
  edits. Never an automatic commit.
- **R5.5 Push and open a pull request** through `gh`, matching the existing
  binding. Confirm before pushing.
- **R5.6 Fix broken checks**: a red chip on failed CI that hands the failing
  job logs to an agent in one click.
- **R5.7 Poll git the way Orca does** — a shallow two-second stat of `.git`
  metadata, never a recursive watcher.

---

## R6 — Teams: a room where agents work together

The largest pillar, and the one where we can be decisively better than the
reference implementation rather than merely equal to it.

### Why we can beat AionUi here

Their team feature is well designed at the contract level and thin underneath.
Four of their weakest points are things we already own.

- **They have no completion protocol.** Members report by writing mailbox
  messages and mutating task status through tools. There is no acknowledged
  transactional "task done" edge, no retry policy and no dead letter, and
  `blocked_by` is descriptive rather than enforced. We have leases,
  idempotent settlement and a run lifecycle in Postgres already.
- **They have no heartbeats.** "Silent agents auto-escalate to failed" is a
  readme claim; in code there is a 500 ms orphan poll and a slow-turn flag.
  A wedged CLI holding an open pipe is precisely the failure we have already
  hit and already instrumented.
- **Their state is single-host and partly `localStorage`.** View mode, member
  colours, ordering and active slot are all browser-local, and slot work state
  is in memory. Ours is server state, so a team is the same on every device
  and survives a restart.
- **They have no worktrees and no diff review.** Their isolation story is a
  workspace mode flag. Ours is a real git worktree per member with branch,
  ahead and behind, diff and merge. That is the difference between agents that
  work in parallel and agents that can be reviewed and merged.

One thing they get right that we should copy exactly: **a member is a slot
bound to an ordinary conversation.** Every single-agent feature — streaming,
tool cards, terminals, approvals, worktree binding — then works inside a team
for free, with no second code path.

### R6.1 Data model

- `teams` — workspace, name, description, leader slot, workspace mode (shared
  worktree or one per member), created by.
- `team_members` — a **slot**: team, agent, role (leader or member), display
  name and colour, optional worktree binding, and its own `chat_sessions` row.
  The same agent may be added twice as two slots with different jobs.
- `team_messages` — the mailbox: from slot, to slot or the broadcast marker,
  kind (instruction, report, question, answer, status), body, referenced task,
  read flag. Append-only.
- `team_tasks` — subject, description, owner slot, status, plus `blocked_by`
  and `blocks` as a real dependency graph rather than a queue, so "who is
  stuck on whom" is one query.

### R6.2 How agents talk to each other

The reference implementation injects a **Team MCP server** into every member
and exposes tools such as `team_send_message(to)`. Membership is gated on the
agent supporting **stdio** MCP, because their processes are co-located.

Ours is served over **HTTP and SSE from this app** (built in R4), which is the
single most important divergence in this roadmap. A member can then run on
another machine, the gate becomes "does this runtime support HTTP MCP" rather
than stdio, and every tool call is a request we can authenticate, authorise,
rate-limit and log. Tools:

- `team_send_message(to, kind, body, task?)`
- `team_read_inbox(since?)`
- `team_list_tasks(filter?)`, `team_claim_task(id)`, `team_update_task(id, status)`
- `team_report_done(task, summary, artifacts?)` — the acknowledged completion
  edge they lack. It writes the mailbox row, settles the task and releases
  dependents in one transaction.

Every one is a plugin-level tool with permissions, so a member can be allowed
to read the board but not close tasks, and a leader can be the only slot
permitted to assign.

### R6.3 The leader, with a fallback

The leader is an agent that plans, splits work into tasks, assigns them and
reviews reports. That is genuinely useful and genuinely fragile: an LLM doing
dispatch with nothing behind it is a single point of failure.

So the board is authoritative, not the leader. If the leader stalls, tasks
whose dependencies are satisfied become claimable by idle members directly,
and the run continues in a degraded but honest mode the UI states plainly.
Warmup gates on the leader alone, so one dead member cannot deadlock the team.

### R6.4 The Teams section — a channel, not a dashboard

A new top-level sidebar entry, **Teams**, listing rooms the way a chat client
lists channels, with unread in bold rather than as a badge.

**Creating a team**: name it, add agents to the room, pick a leader, choose
shared or per-member worktrees, and optionally bind a project. Adding an agent
adds a slot, so the same agent can appear twice.

**The room itself**, three views over one set of data.

- **Channel** — the default. One chronological feed: the human's instructions,
  the leader's messages to members, members' reports, task events and
  approvals inline. Every message names its sender and recipient, so watching
  the leader delegate is the primary thing on screen rather than something to
  reconstruct. Clicking a member's message opens their thread beside it.
- **Lanes** — a column per member, each a live thread with its own streaming
  text, tool cards and terminal, so parallel work is legible at a glance.
- **Board** — the dependency graph, with blocker chips that jump to the
  blocker, and a merge action per member worktree.

**Terminals.** A dedicated strip showing every member's live terminal at once,
reusing the existing terminal block with its exit codes and kill states. This
is the view for "what are they actually doing right now".

**Presence and honesty.** Each member shows idle, thinking, running a tool,
waiting on approval, blocked, or lost, derived from the run and its heartbeat
rather than guessed. A slow turn is flagged before it becomes a timeout.

### R6.5 BlockSuite in the channel, done the way that stays fast

The goal is right: the channel should render our own components, so an agent
can emit a diff, a run card, a task or an in-page session and have it appear
inline, and so anything built later renders there too.

The way to get that without paying for it is to **share the renderer, not the
document**. Extract the block renderers the editor uses into a registry both
the page editor and the channel feed consume. A message then names a block
type and its props, and the channel renders the same component the editor
would.

**Do not stream the live feed into a BlockSuite document.** A CRDT is the
wrong substrate for a high-frequency append-only log: every token becomes a
Yjs update and a persistence write, and a busy room with five members would
spend its time merging rather than rendering. The feed stays a virtualised
React list over the typed `RunEvent` stream, which is already the fast path.

Each channel then gets a **canvas**: a real BlockSuite document attached to the
room for durable artifacts — the plan, the spec, the summary. Agents write
into it, humans edit it, and it is where "save this reply as a page" lands when
it happens inside a team. Full editor where a document belongs, firehose where
a firehose belongs.

### R6.6 Reliability

- Heartbeats per member; a silent slot is marked lost and its task returned to
  the board rather than left assigned.
- Every tool call idempotent by task and slot, so a retry cannot double-book
  work.
- Dead letter for messages addressed to a slot that no longer exists.
- Decision gates reuse the existing approvals mechanism, so a member needing
  permission raises the same card a solo run raises.
- A room-wide stop that cancels every in-flight member turn cooperatively.

### R6.7 Done when

Two members can be given one objective by a leader, work in separate
worktrees, message each other through the board, hit an approval gate, be
reviewed as diffs, and be merged — and the whole thing survives a server
restart mid-run.

## R7 — Runtime panels and polish

- **R7.1 Settings gets a Runtimes section**, and each installed runtime
  contributes its own panel. Hermes contributes model and fallbacks,
  providers, profiles, skills, MCP servers and safety. A runtime that is not
  installed does not appear.
- **R7.2 Two Hermes features stay Hermes-only forever**: crons and the skill
  hub install flow. Neither has an ACP analogue. Do not try to generalise
  them.
- **R7.3 Agent detail completeness**: a Sessions tab filtered to that agent,
  read-only views of its skills and MCP servers linking to the settings that
  edit them, spend over seven and thirty days.
- **R7.4 Remaining page work** from Roadmap A: the record detail header, page
  provenance, the persistent re-runnable block, suggest-edits page writes, and
  the projects and tasks list wins.

---

## Known blockers, stated plainly

1. **Extraction has to precede the second runtime.** Doing it afterwards means
   rewriting the dispatcher twice.
2. **The import cycle and the client-bundle risk are real today**, not
   introduced by this work. R1.1 and R1.5 exist to find out before moving.
3. **Team transport is the one place AionUi's design does not carry over.**
   Their stdio gate would exclude every runtime we care about in a server
   deployment.
4. **The leader-as-orchestrator pattern needs a fallback** before it is
   trusted with real work.
5. **Session resume is unbuilt, not partially built.** Plan it as new work.
6. **Abstractions rot.** AionUi accumulated four deprecated backend kinds in
   about a year. Every capability flag we add should be derived from the
   handshake, so there is nothing to deprecate later.
