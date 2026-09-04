# Roadmap series — from a Hermes app to an agent harness

Supersedes `ROADMAP-A-PAGES.md` (mostly delivered) and `ROADMAP-B-HARNESS.md`
(folded in below). Eight roadmaps, ordered so that each one makes the next
cheaper rather than harder.

---

## D0 — Latency is the first priority, and it outranks every other decision here

This rule comes before the five decisions below and overrides them where they
conflict. If a feature is only achievable by making the app slower, the
feature is wrong, not the budget.

**What it forbids, concretely.**

- **No CRDT on a streaming path — the rule is about write frequency, not
  about Yjs.** A high-frequency append-only log must never live in a Yjs
  document: every token would become a document update and a persistence
  write. Per *block*, the same substrate is correct and cheap, and it is the
  only thing that makes a human and an agent editing one page at once work
  without hand-written conflict logic. So the line is drawn at granularity.
  Feeds and transcripts are virtualised React lists over the typed `RunEvent`
  stream. Documents are BlockSuite, written a block at a time by a tool call
  that has already left the hot path. See R8.
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
- **R4.6 The artifact server is the first plugin-level MCP we ship**, and the
  proof the layer works. It is specified in R8.5. Build R4.1 and R4.2 with it
  as the concrete consumer rather than as a hypothetical one.

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

### R6.5 BlockSuite in the channel — the thread is a log, the page is a document

**Superseded decision.** An earlier draft of this section proposed sharing a
block-renderer registry between the page editor and the channel feed, so a
message could name a block type and render the same component the editor uses.
That is no longer the plan. It coupled the feed to the editor's component tree
for a benefit we can get more cheaply, and it put a document concern on the
hot path. See R8, which replaces it.

**The rule that survives, restated precisely.** The forbidden thing was never
BlockSuite. It was **write frequency**. Per token, a CRDT is catastrophic:
every delta becomes a Yjs update and a persistence write. Per block, it is
correct and cheap, and it buys the one thing that is genuinely hard to build
by hand — a human editing the top of a page while an agent appends to the
bottom, merged without a line of conflict logic.

So the boundary moves from the technology to the granularity.

- **The channel feed stays a virtualised React list** over the typed
  `RunEvent` stream. It renders hand-written components, not editor
  components, and it pays nothing per token beyond mutating one string.
- **The channel canvas is a real BlockSuite document** attached to the room,
  holding the plan, the spec and the summary. Agents write into it through the
  scoped handle in `lib/agent-page-writes.ts`, humans edit it directly.
- **Feed components and page components are allowed to be different
  implementations**, and should be. A diff in the feed is a collapsed glance
  you scroll past. A diff in a page is full width with comment anchors.
  Different context, different density. Forcing one component to serve both
  makes both worse, and the duplication is smaller than the coupling it
  replaces.

**Nothing extra happens while streaming.** No block-type resolution, no
registry lookup, no props envelope, no document write. The conversion from
conversation to document happens on demand, after a turn, through the
artifact tools in R8.

BlockSuite in a team room is therefore R8 applied to a channel: the room owns
a canvas, and every member writes to it through the same MCP surface every
solo session uses. There is no team-specific document code.

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

---

## R8 — Artifacts: what agents author, and where it lives

This pillar replaces the shared-renderer idea in the earlier R6.5 draft, and
it is the differentiator. Every other agent product returns text. This one
returns **documents you can edit**, produced by the agent through the same
editor a human uses, without the thread paying for any of it.

### R8.0 The decision

An agent has two output channels and they are not the same thing.

- **Prose goes in the thread.** Explanation, reasoning, answers, questions.
  The thread is an append-only log and stays exactly as fast as it is today.
- **Structure goes in an artifact.** Tables, specs, plans, checklists,
  comparisons, reports, anything the human will edit afterwards. An artifact
  is a real BlockSuite page in the document tree, or an HTML document, opened
  in a panel beside the conversation.

The thread then carries a compact **artifact card** referencing what was
created. Clicking it opens the panel, not a new route.

This is why it costs nothing at stream time: creating an artifact is a tool
call, and tool calls already happen after the model has decided, not per
token. A large generated page is a few dozen block insertions across an
entire turn. That is negligible for Yjs and it is not on the render path of
the feed.

### R8.1 What the thread persists

Two logs, and only one is durable.

- **Transport** carries deltas, thinking and tool calls. It exists for the
  duration of a turn and is dropped once the message commits. Nothing in the
  product reads it back.
- **The record** stores the final assistant output as text, plus references
  to artifacts the message created or touched. No tool calls in message
  content, no thinking, no deltas.

Keep a bounded, time-expiring run trace off to the side for debugging and for
the agent's own working context. It must not enter the message model, or it
grows back into a transcript.

**Accepted cost.** Provenance gets weaker. An artifact can point at the
message and run that produced it, but not at the individual tool calls behind
it, because those are not kept. That is the right trade and it is taken
deliberately.

### R8.2 The data model

`collections/Artifacts.ts` today is P2.1 scaffolding: `task` (required),
`name`, `url`. That shape cannot express any of this and must be widened.

- `workspace` — required, the tenancy boundary.
- `kind` — `page` or `html`. One record type, two payloads.
- `page` — relationship to `pages`, set when `kind` is `page`. The artifact is
  a pointer; the document itself stays in `Pages` with its `docState`, so it
  is a first-class page with search, favourites, permissions and history for
  free.
- `htmlContent` — set when `kind` is `html`. Rendered sandboxed, never
  same-origin.
- `project` — optional relationship, and the field the whole placement rule
  turns on. `Pages` already carries `project`, so a page artifact keeps the
  two in step.
- `session` and `run` — what produced it. Optional, because a human can create
  an artifact by hand.
- `task` — becomes **optional**, which is the breaking change to the existing
  collection. A migration must backfill `workspace` from each row's task.
- `createdByAgent` — which slot or agent authored it, so the list can be
  filtered by author.

### R8.3 The placement rule

One rule, stated once, applied everywhere.

- **A session bound to a project** puts its artifacts **inside that project**.
  They appear in the project's own pages and resources, alongside everything
  else that project owns. They do not appear in the global Artifacts section,
  because they already have a home.
- **A session with no project** produces **loose artifacts**, and those are
  what the Artifacts section lists. It is the inbox for output that has not
  been filed yet.
- **Filing is a move, not a copy.** Assigning a project to a loose artifact
  sets `project` on both the artifact and its page, and it leaves the
  Artifacts list. Clearing it sends it back.

The rule generalises to teams with no special case: a room bound to a project
files its canvas and its members' artifacts into that project, and an unbound
room's artifacts are loose.

### R8.4 The Artifacts section

A top-level sidebar entry listing loose artifacts newest first, and nothing
else. Its job is to be emptied.

- **A card per artifact**: title, kind, authoring agent, session it came from,
  and when. Page artifacts show a first-lines preview from
  `pages.plainTextContent`, which already exists and costs no extra read.
- **Filters** for kind, agent and session. No board, no grouping, no saved
  views. This is a triage list.
- **Open** puts the artifact in the side panel over the current context, the
  same panel the conversation uses, so opening one never loses your place.
- **File into a project** is the primary action on every card, and it is one
  control. Bulk select for filing several at once.
- **The empty state says what it means.** Nothing here is the healthy state,
  not a missing feature, and the copy should say so.

### R8.5 The internal MCP — how agents author artifacts

This is a **plugin-level** server by D4: our database, our permissions, our
team access, injected per run. By R4.2 it is served over **HTTP and SSE from
this app**, never stdio, so a member on another machine can author into a
document and every write is a request we authenticate, authorise, rate-limit
and log.

The agent never touches Yjs. It gets a small, closed verb set.

- `artifact_create({ kind, title, project? })` — creates the page or HTML
  record, applies the R8.3 placement rule when `project` is omitted, returns
  an artifact id and an open URL.
- `artifact_append({ artifact, blocks[] })` — appends block specs in order.
  Batched, because a page is written in one call, not one call per paragraph.
- `artifact_update_block({ artifact, block_id, spec })` — replaces one
  block's content, for revision passes.
- `artifact_read({ artifact })` — the current document as block specs, so an
  agent can revise a page it wrote last week rather than starting over.
- `artifact_list({ project?, session?, limit })` — discovery.

**Two ownership modes, one module.** `lib/agent-page-writes.ts` already
implements the hard one correctly: a run holds a scoped subtree handle,
appends only under blocks it owns, and never calls `updateBlock` or
`deleteBlock`. Keep that exactly as it is for **appending into a human's
page**. Add a second mode for a page the run itself created, where the run
owns the whole document and update and reorder are legitimate. The scoping
check is the same code with a different root.

**The block vocabulary is the product surface.** `AgentBlockSpec` today is
`heading | paragraph | list | code`. That is enough for prose and not enough
for a document worth generating. Extend it to the flavours that already
exist, which is mostly wiring rather than new editor work.

- `table` maps to the native database block, flavour
  `affine:embed-teable-native`, already registered in `lib/blocksuite-doc.ts`.
  This is the answer to "the agent should be able to make tables", and it
  yields real columns, types and views rather than a static grid.
- `run_card` maps to `affine:embed-run-card`, already registered.
- `task` maps to `affine:embed-task`, already registered.
- `agent_session` maps to `affine:embed-agent-session`. Its schema exists at
  `components/editor/blocks/agent-session/schema.ts` but is **not** in the
  `Schema().register` call in `lib/blocksuite-doc.ts`, so a server-side write
  of it would fail today. Register it.
- `quote`, `divider` and `image` are plain Affine flavours needing no new
  schema.
- `diff` has no block flavour anywhere in the codebase, as
  `lib/agent-page-writes.ts` already notes. It needs a real schema, custom
  element, spec and registration. Treat it as its own task, not a spec entry.

**Never let the agent write markdown for us to parse.** A markdown pipeline
permanently caps the product at what markdown expresses and makes every
custom block unreachable. Emitting typed block specs is the entire
differentiation, and it lives in this tool schema.

**Policy belongs in the system prompt, not in code.** Prose stays in the
thread. Structure becomes an artifact. A short answer never gets one. Without
an explicit threshold the agent will either create a page for every reply or
never create one, and both failures are worse than the feature.

### R8.6 The panel, and streaming at block level

Side by side, not a link. Navigation breaks the loop where a human reads the
artifact and immediately tells the agent to change it, and co-presence is the
whole work pattern.

- The panel opens over the current route and holds the full editor, not a
  preview. Editing it is editing the page.
- Blocks appear as they are written. One SSE subscription per open artifact,
  carrying block-level changes only. It reads as alive and costs nothing on
  the feed, because the feed is not involved.
- The thread card shows live status while a turn is writing, then settles to
  a static reference.

### R8.7 Reliability and concurrency

- **Idempotency per tool call**, keyed by run and call id, so a retry cannot
  duplicate a page or double-append a section.
- **Rate limit blocks per turn** with a hard ceiling. A looping agent must not
  be able to write a ten thousand block document.
- **Presence in the panel.** Show that an agent is writing, and where.
- **Soft lock the block under a human cursor.** The CRDT merges either way,
  but merging a human mid-sentence with an agent rewrite is correct and still
  infuriating.
- **A deleted handle stops the run's writes** rather than recreating them.
  This is already the behaviour of `appendBlockToSubtree` and it is right: the
  human deleting the output means they do not want it.
- **HTML artifacts render sandboxed**, with no same-origin access and no
  ambient credentials.

### R8.8 Done when

An agent asked for a comparison writes a page containing a real table, the
page opens in a panel beside the conversation while blocks land one at a
time, the thread holds only the final prose and a card, the artifact appears
in the Artifacts section because the session had no project, filing it into a
project moves it out of that list and into the project, and a human editing
the top of the page while the agent writes the bottom loses nothing.

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
7. **`collections/Artifacts.ts` has to change shape before R8 starts.** It is
   task-bound scaffolding with a required `task` and a required `url`. R8
   needs `workspace`, `kind`, `project` and an optional `task`, which is a
   migration with a backfill, not an additive field.
8. **The block vocabulary is the bottleneck, not the tool surface.** Writing
   the artifact MCP is small. Every block type an agent can emit that does not
   already exist as a registered flavour is its own editor task, and `diff` is
   the first one due.
9. **The prose-versus-artifact threshold is a prompt problem with no
   fallback.** Get it wrong and the agent either files a page per reply or
   never files one. It needs evaluation against real sessions before the
   feature ships, not after.
