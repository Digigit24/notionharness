# Roadmap series — from a Hermes app to an agent harness

Supersedes `ROADMAP-A-PAGES.md` (mostly delivered) and `ROADMAP-B-HARNESS.md`
(folded in below). Nine roadmaps, ordered so that each one makes the next
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

## R3 — Correctness: resume, failure, and the truth — DONE

Folded from the old B1, B2 and B4. Every item below was verified against the
real binary or measured, not reasoned about.

- **R3.1 Session resume — DONE, and it uncovered a trap.** The ACP session id
  was write-only; it is now passed on the next turn via `session/load`.
  Verified with `scripts/test-session-resume.ts`: turn one stores a codeword,
  the process is torn down, and turn two — a *new* agent process — recalls it.
  The trap: **Hermes accepts a session id it never minted and answers
  `session/load` with success**, resuming into an empty context. Trusting the
  response would have produced an agent that silently forgot everything. What
  does distinguish the two is the replay — a real session hands its history
  back as `session/update` notifications during the load (2 for a one-turn
  conversation), a session the agent does not have hands back nothing. That
  count is the check. A failed resume falls back to a fresh session, says so
  in the transcript as a system message, and overwrites the dead id so the
  next turn does not retry the same doomed load forever.
- **R3.2 Terminal death — already built.** `TerminalBlock` distinguishes
  `exited 0`, a non-zero exit, `killed (signal)`, and the case that matters
  most: the run ended and the shell never reported at all, which is the shape
  a hung node-pty process has. Wired end to end through the adapter.
- **R3.3 Dispatcher supervision — DONE.** `dispatcher_heartbeat` (one row,
  ever — nobody needs tick history) is written on every tick;
  `getDispatcherHealth()` reads it and answers the question that matters,
  which is not "is it idle" but "is it stopped *while work is waiting*". The
  Health page carries a tile and, when stalled, a loud banner naming the
  command to start it. Nothing starts a process on its own: a page render that
  silently spawned workers would hide this exact failure.
- **R3.4 Worktree retention — DONE, armed manually.** `reclaimRunWorktrees`
  keeps a checkout for three reasons and removes it only when none apply: the
  run is unfinished, its review is still open (a page subtree with a pending,
  undismissed suggestion), or it is among the last N settled runs. Measured on
  this machine: 79 checkouts, 59 reclaimable, 184 MB. The automatic hourly
  pass is **off unless `RUN_WORKTREE_AUTO_RECLAIM=true`** — deleting a run's
  diff is irreversible and only the machine's owner knows which old run still
  matters. `scripts/reclaim-worktrees.ts` is a dry run by default.
- **R3.5 Wedge detection — already built.** `sendTurn` runs two independent
  caps: a wall clock, and an inactivity watchdog. Silence is the signal that
  separates a legitimately long run (constantly emitting) from a wedged one
  (emitting nothing) — a wall clock alone cannot tell them apart and cost the
  full cap every time.
- **R3.6 Approval timeouts — DONE.** The `timeout` status had existed on the
  collection since it was written and *nothing ever wrote it*, so an
  unanswered request stayed `pending` forever: still listed, still clickable,
  answering it did nothing and said nothing. `waitForApproval` now settles the
  row too, scoped to rows still pending so a decision landing in the same
  instant wins the race — which is the right way round.
- **R3.7 Streaming — measured, and the answer is do nothing.**
  `scripts/test-streaming-latency.ts` adapts growing transcript prefixes,
  because `adaptRunEventsToThread` re-runs over every prior envelope each time
  one event arrives — the quadratic risk. Result: **0.12 ms at 4000 events**,
  and cost grew 7.2x while the transcript grew 40x, so it is sublinear, not
  quadratic. The hundred-message tail stays. A virtualiser would add
  measurement thrash to rows whose heights change continuously while
  streaming, to solve a problem the numbers do not show. The reveal buffer now
  no-ops under `prefers-reduced-motion`, where the accessible choice and the
  fast choice happen to be the same choice.
- **R3.8 Secret redaction — DONE.** `lib/redact.ts` strips credentials from
  agent text before it reaches the server log, the `runs.error` column, or a
  chat bubble someone may screenshot. Shape-based rather than a vendor list —
  credentials in a URL, bearer tokens, JWTs, and long values after an
  obviously secret-sounding name — with a small prefix list underneath, not
  instead. `scripts/test-redaction.ts` checks both halves: secrets go, and
  ordinary error text survives untouched, because an over-eager redactor that
  eats real error messages is its own bug. 14 cases, all passing.

---

## R4 — The plugin layer: our MCP, our skills, our connectors — DONE

This is the prerequisite for teams, because team tools ride on it.

The organising idea, which everything below follows from: **there are two
kinds of tool and they differ by ownership.** The runtime has its own MCP
servers in its own config, which `hermes mcp add` edits behind our back — we
read and toggle those and write no ownership into them. Plugins are ours:
workspace rows, scoped to specific agents, injected at `session/new` and gone
when the turn ends. Only the second kind can be granted to one agent and not
another, which is what makes per-agent and later per-team tool access possible
at all.

- **R4.1 Plugin registry — DONE.** `collections/Plugins.ts` plus
  `lib/plugins/resolve.ts`, one function the dispatcher calls per run.
  Scope defaults to "selected agents" with an empty list, so a new plugin
  reaches nobody until someone says who — the safe direction for a thing that
  grants capability. A disabled plugin is *absent* from the session rather
  than present-and-refusing, because an agent that can see a tool it may not
  use will keep trying and narrate the failure at the user. A row that cannot
  be turned into a server is reported into the transcript, not dropped.
- **R4.2 HTTP and SSE, not just stdio — DONE.** Confirmed by reading the ACP
  SDK's own zod definitions: `McpServer` is a union of http, sse, acp and
  stdio. AionUi gates team membership on `mcpCapabilities.stdio` because their
  processes are co-located; ours are not, and that gate would be simply wrong
  here. HTTP is the default.
  - **The problem this raised, and the fix.** A plugin row is static
    configuration; the credential an agent needs is per-run and short-lived.
    Storing a live token in the row would outlive the run and sit in the
    database; a shared permanent key would be worse. So header and env values
    support `{{RUN_TOKEN}}` / `{{RUN_ID}}`, substituted at resolve time and
    nowhere else. The row stays inert. An unknown placeholder is left visible
    rather than blanked, so a typo shows up in the request instead of becoming
    a silently empty header.
- **R4.3 Runtime-level mirror — was already built.** The MCP settings screen
  reads and writes through the runtime's own API and keeps no mirror table,
  with the reasoning already recorded in its own header: a mirror would be
  wrong the first time someone ran `hermes mcp add`.
- **R4.4 Composio — reachable as configuration, no adapter written.** Composio
  serves MCP over HTTP, and R4.2 means an HTTP MCP endpoint is a plugin row.
  So this needs a row, not code — which is D1's whole thesis applied one level
  up. Connectors were explicitly deferred, so no SDK integration was written;
  what changed is that adding one is now data entry rather than a project.
- **R4.5 Self-describing config options — DONE.**
  `components/settings/plugin-config-fields.tsx` renders `{ id, label, type,
  options }` for string, boolean and select. Three types on purpose: a form
  builder that supports everything ends up a worse version of a real form for
  every specific case. Values ride to the plugin as ACP `_meta`, which is
  free-form on every server variant, so a plugin reads its own configuration
  without us inventing a side channel.
- **R4.6 The artifact server as first consumer — shipped as `/api/mcp`.**
  Built against a real endpoint rather than a hypothetical one, as this item
  asked. It exposes `get_page` and `append_block`, the surface
  `scripts/notionforge-mcp.ts` already had over stdio, moved to where an agent
  on another machine can reach it. Writes route through
  `lib/agent-page-writes.ts`, the one module that guarantees a run can only
  append under a block it owns and can never update or delete.
  - **Auth reuses what runs already have**: the presented token is compared to
    that run's own `run_token`, exactly as `/api/daemon/page-writes` does, so
    there is one authorisation rule for agent writes rather than two that
    drift. Naming a different run id does not help someone holding another
    run's token, and a settled run is refused.
  - **Artifact-specific tools wait for R8**, which widens
    `collections/Artifacts.ts` and needs a backfill. The transport and registry
    are proven now; the artifact vocabulary lands with its data model.
  - **One live bug worth recording.** The first working version returned 200
    with an empty body. Cause: the transport defaults to SSE, so
    `handleRequest` returns a Response still being written, and closing the
    server in `finally` tore the stream down before a byte reached the client.
    These tools are request/response and stream nothing, so
    `enableJsonResponse: true` is both correct and what makes the cleanup safe.

**Verified:** `scripts/test-mcp-endpoint.ts` (9 checks, including three
distinct ways of being unauthorised) and `scripts/test-plugin-injection.ts`
(12 checks, all passing) — including the one that matters most, that another
agent in the same workspace does *not* receive a scoped plugin.

That last check nearly went unverified. The test picked the first workspace it
found, which had one agent, and reported the cross-agent assertion as skipped
— while a four-agent workspace sat one row further down. It now picks a
workspace that can actually exercise the assertion. A test that skips its most
important case and still prints ALL PASS is worse than no test.

---

## R5 — Git review, the part Orca does best — CORE DONE

Folded from the old B3, plus what is still missing.

- **R5.1 A git rail in the conversation — DONE.** `components/work/git-rail.tsx`
  shows branch, ahead/behind, changed files and their diffs beside the thread,
  for a session bound to a worktree. This is the whole point of that binding:
  the person asking "what did it just do" is looking at the conversation, and
  until now the answer lived on a different screen.
  - **Scoping is the safety story.** Every action resolves the session to its
    bound worktree server-side, so there is exactly one place that decides
    which directory a git command may touch, and it is derived from stored
    state rather than anything a caller passes in. An unbound session shows
    nothing rather than falling back to a default repository — staging changes
    in a checkout you were not looking at is the failure to prevent.
- **R5.4 Stage, unstage, commit — DONE.** Never an automatic commit: the
  message the person sees is the message that is used. `suggestCommitMessage`
  drafts from the staged paths and is deliberately mechanical, not a model
  call — a round trip and a cost for a field the human is about to rewrite,
  when the useful answer ("which files am I committing") is already in the
  repository.
- **R5.5 Push and open a pull request — DONE**, through `gh`, matching the
  existing binding so no GitHub token ever passes through this app. Both
  confirm before acting, every time, because pushing publishes work other
  people can see and approval of one push is not approval of the next. The
  pull-request button is disabled, with the reason on hover, when `gh` is not
  authenticated — rather than failing after the push has already happened.
- **R5.7 Polling — resolved by not polling.** The rail reads git on demand and
  after its own writes. A two-second stat loop is a real cost on a panel that
  is usually closed, and D0 is explicit about intervals. The state that must
  never be stale is the index at the moment of a commit, and that cannot be:
  the commit reads the index server-side rather than trusting what is drawn.

**Still open, named honestly rather than quietly dropped:**

- **R5.2 Side-by-side diff with hunk staging** and **R5.3 line-anchored
  comments batched into one prompt**. The rail currently reuses
  `components/thread/DiffBlock.tsx`, which classifies line by line and never
  throws. That is the right renderer for agent output of unknown shape, and
  the wrong one for annotation: R5.3 needs arbitrary React widgets pinned to a
  side and a line, which is exactly the primitive `@git-diff-view/react` was
  chosen for and which this does not have. The dependency is not yet added.
  R5.2a still holds — the feed keeps its own forgiving renderer either way.
- **R5.6 Fix broken checks.** Not started; it depends on nothing above, so it
  is cheap to add later.

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

## R7 — Runtime panels and polish — DONE

- **R7.1 Per-runtime settings — DONE.** Providers is tabbed per runtime, and
  the tabs are genuinely different screens because the runtimes differ in kind:
  Hermes owns providers and credentials in its own config, a protocol-native
  runtime declares its models over ACP and holds its own credentials. Agent
  settings likewise render by runtime. Both read the runtime's self-describing
  `session/new` config options, so a new runtime needs no new screen and a new
  model needs no release from us.
- **R7.2 Hermes-only features fenced off — DONE.** Model & fallbacks, Profiles,
  Skills, MCP servers and MCP catalog now live in a `Hermes` group in the
  settings rail, shown only when the workspace has an enabled Hermes runtime.
  This is not tidiness: those screens edit a Hermes install — a profile is a
  whole alternate HERMES_HOME, the skill editor writes files into it, the MCP
  screens edit its `config.yaml` — so in a Claude-only workspace they would be
  controls that write nowhere. A profile predating `homeStrategy` counts as
  Hermes, so nothing anyone is already using disappears.
- **Runtime health — FIXED, and the fix had two layers.** Health ran Hermes's
  dashboard probe for every profile, so a working Claude runtime reported
  "Hermes responded 502". Fixing only that left the same error one level up:
  with the dashboard down, a Hermes runtime that demonstrably runs turns was
  still reported "down". Status now means one thing everywhere — can it
  complete a handshake, which is to say can it run a turn — and the dashboard
  is reported as its own fact. "Runs fine, but its Hermes dashboard is
  unreachable" is a real state worth naming: turns work, the Hermes settings
  screens do not. Probes are reused for ten minutes so a 30-second health loop
  does not spawn binaries continuously (D0).
- **R7.3 Agent detail completeness — DONE.** A Sessions tab listing that
  agent's own conversations, each linking into Work rather than being a second
  transcript viewer that would drift from the real one. Capabilities is now
  runtime-aware: it showed Hermes skills and MCP servers for every agent, which
  for an agent on any other runtime was an empty panel fetched from an install
  it has nothing to do with — so a non-Hermes agent sees the plugins scoped to
  it instead, and both views link to the settings that edit them. Spend is
  shown over 7 **and** 30 days, because either alone leaves a real question
  unanswerable: 7 hides a burst that has tailed off, 30 lags a change in
  behaviour.
- **R7.4 Remaining page work from Roadmap A — DONE.**
  - **Record header and page provenance (A5.1, A5.3).** Row pages and task
    documents are kept out of the sidebar tree on purpose, which left them with
    no on-screen context at all — no way to tell which table a row belonged to,
    and no way back but the browser button. `lib/page-origin.ts` resolves it and
    a strip states it. The row title comes from the database's primary field
    and never falls back to the record id, which would have reintroduced the
    original `Record aojhfiefhh` bug one layer up.
  - **Persistent, re-runnable block (A1.5).** The agent-session block offers
    Run again on the last prompt. The previous answer stays as history and the
    new one is appended below it rather than replacing it: a page is a
    document, and silently rewriting what someone already read is the wrong
    default here.
  - **Suggest edits (A3.5).** Per-block accept and reject. The documented
    blocker — a per-block suggestion *mark* needs a schema this app does not
    own — is about marking, not about acting: the run's subtree already **is**
    the proposal container, so rejecting one block deletes it and accepting one
    moves it out into the page, using the same always-supported primitives the
    whole-run actions use. No new flavour, and no pretending the marking
    problem was solved. Nine checks passing.
  - **List wins.** Project rows carry task count, runs in flight and last
    activity, in one query rather than three per project. The tasks board
    accepts `?project=`, filtered in the query so a large workspace does not
    fetch rows it is about to discard.
  - **A real bug found here:** the tasks page destructured
    `[statuses, projects, agents]` from a `Promise.all` returning
    `[statuses, agents, projects]`, so the board was handed the agent list as
    its projects and vice versa.

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

## R9 — The repository browser: a project's files, read through git

R5 reviews what changed. This reads what is there. A project bound to a local
repository should show its files the way GitHub does — browse the tree, open a
file, read the code, preview a README — without leaving the projects page.

### R9.0 The decision: read through git, never mirror

The instinct is to index the working tree into Postgres and keep it in sync.
That is wrong twice over. It buys a permanent staleness bug, and it breaks
D0's "cache what is stable, never what is live." GitHub does not mirror
either; it reads the object database per request and caches on content
address. So git is the read path, and the only thing cached is what git
guarantees cannot change.

- **Listing is one level deep.** `git ls-tree -l <ref> <path>/` returns name,
  type, size and blob oid for a single directory, and `git status
  --porcelain` overlays dirty and untracked markers. That is O(directory),
  never O(repo), and it is why a repository carrying a large `node_modules`
  costs nothing to browse.
- **Reading is one blob.** `git show <ref>:<path>` for a committed file,
  `fs.readFile` for the working tree. Cap around a megabyte, and call a file
  binary when a NUL byte appears in the first eight kilobytes rather than
  guessing from its extension.
- **Cache by blob oid, forever.** A blob oid is content-addressed, so its
  content can never change. An in-memory LRU keyed by oid and an immutable
  cache header are both safe. This is free speed rather than a trade, and it
  is the one place in this pillar where caching is unambiguously correct.
  Directory listings key on the commit sha and expire with it.
- **Change detection is R5.7's stat, reused.** Stat `.git/HEAD` and
  `.git/index`, and invalidate when either moves. Never a recursive watcher.
  A repository tree is exactly the case D0's polling exception was written
  for — the thing being watched is genuinely outside the database.
- **Every path goes through `pathIsInside`**, which already exists in
  `lib/git/repo.ts`. Traversal is the entire attack surface of this feature
  and the defence is already written.

### R9.1 The UI is ours, and it is small

No file-manager library. The category is built for upload managers rather than
code browsing, and the maintained ones are the wrong shape. GitHub's own
browser is a breadcrumb, a flat table of one directory, and a file view.
`buildFileTree` in `components/runs/review-panel.tsx` and
`components/sidebar/page-tree.tsx` already carry most of that.

- A breadcrumb and a directory table: name, type, size, and its status if the
  working tree has touched it.
- A file view with a line gutter, deep-linkable by line, so a comment or an
  agent can point at one.
- A ref picker sharing the base-ref control built in R5.2.
- If a persistent sidebar tree is wanted later, lazy-load it over
  `@tanstack/react-virtual`, already a direct dependency. Reach for a tree
  library only if that fails, and not before.

### R9.2 Highlighting happens on the server

Shiki is in the tree already at `1.29.2`, transitively through BlockSuite.
**Promote it to a direct dependency pinned at that exact version**, or a
second copy ships in the bundle and a BlockSuite bump silently changes how our
code renders. Highlight inside a server component and send marked-up HTML: a
client-side highlighter on a large file is precisely the render-path cost D0
forbids, and this is the largest single latency win available in this pillar.

### R9.3 Preview, and the two file types that get one

- **Markdown** renders server-side through `marked`, already present
  transitively, and is sanitised before it reaches the page. Sanitising is not
  optional: markdown permits raw HTML, and this is a file out of a repository.
- **HTML** renders in a sandboxed iframe with no same-origin access and no
  ambient credentials, ideally from a separate origin. That is R8.7's rule
  restated, and it applies unchanged to a repository file.
- **Nothing else gets a preview.** Images and binaries state what they are and
  how large they are. A preview surface that grows one type at a time is how
  this becomes a file manager nobody asked for.

**The BlockSuite path exists, and it is not this.** The markdown adapter, with
`unified` and `remark-parse` already installed, could turn a README into a
real editable document. That is the R8 move — open this README as a page — and
it belongs there, not in a read-only browser where mounting Lit inside a React
table would cost real weight for nothing.

### R9.4 Where it lives

A **Files** tab on the project detail view, beside the existing overview,
resources, runs and worktrees tabs. A worktree gets the same browser pointed
at its own checkout, which is what makes R5's review and R9's browsing one
surface rather than two.

### R9.5 Done when

A project bound to a local repository lists its root in one git call, opens a
file highlighted on the server, previews a README as sanitised HTML and an
HTML file in a sandbox, deep-links to a line, and reflects an external commit
within one poll — with no mirror table, no recursive watcher, and no listing
that walks more than the directory it was asked for.

---

## R10 — First run: the gap between signing up and anything working

Not an insert into an existing pillar. It cuts across runtimes, models, the
dispatcher and Work, and it is the one path every user takes exactly once,
badly.

### R10.0 What a new signup hits today

Walked end to end: sign up, land on a workspace picker with nothing to pick,
create a workspace, arrive in an empty one with a three-step checklist. Step
one reads *"Add a runtime profile pointing at a real ACP or MCP command, and
enable it."*

That sentence is the entire onboarding, and it assumes the reader knows what
an ACP command is, which binary provides one, and where it lives.

We know exactly how hard that step is, because it was done by hand on this
machine and took: knowing Claude Code does not speak ACP natively, finding the
adapter, discovering the obvious package is **deprecated and renamed**,
installing it, knowing `homeStrategy` had to change from `hermes` to `none`,
and knowing the probe was telling the truth when it said `acp_init_timeout`.
A new user hits `command_not_found` or a twenty-second timeout with no way to
tell whether the product is broken or they are.

And with every one of those correct, **nothing runs** until the dispatcher
loop is started — which nothing starts, deliberately (R3.3).

### R10.1 The principle: detect, do not instruct

Onboarding should tell the user what their machine already has, not ask them
to describe it. Everything needed for this already exists — `probeAcpRuntime`
and `resolveSpawnCommand` (R1, hardened when Claude Code was added) — and
nothing has ever pointed them at the empty-workspace case.

Honest by construction: every row on the screen is a real handshake, not a
capability list we maintain.

### R10.2 The flow

- **R10.2a Signup creates the workspace.** A first user lands on a picker with
  nothing to pick and then a create form. Collapse it: signup makes the
  workspace and goes straight in. The picker stays for people with several.
- **R10.2b Scan.** On first load of an empty workspace, probe a short list of
  known agent commands (`hermes-acp`, `claude-agent-acp`, `claude`, `codex`,
  `gemini`, `opencode`) through the resolver that already handles Windows
  `.cmd` shims. Three groups: **ready** (handshake ok, with the agent's own
  self-reported name), **needs one step** (binary present, no ACP — the Claude
  Code case, naming the exact adapter), and **not installed** (named, with a
  link, never hidden).
- **R10.2c Confirm one runtime.** Clicking a ready row creates the profile
  with the right `homeStrategy` — `hermes` for Hermes, `none` for everything
  else — which is precisely the thing that had to be corrected by hand.
- **R10.2d Model.** Runtime-aware, reusing R7: a Hermes runtime shows its
  profiles, a protocol-native one shows the models it declared in its own
  `session/new`. A runtime with no credentials says *that* and links to its own
  login. We hold no provider tokens and must not start.
- **R10.2e The dispatcher, stated plainly.** A checklist item reading the R3.3
  heartbeat: nothing will run until the loop is started, with the command.
  Green when the heartbeat is fresh.
- **R10.2f First turn inside the product**, not a tour. Pre-fill the Work
  composer with a real prompt and let them press Enter. Success is a streamed
  reply, which proves every step above end to end.

### R10.3 Decisions taken

- **Installing the adapter: show the command, offer the click, never silent.**
  A copyable command by default, with a one-click install behind an explicit
  confirmation that names the package. Running `npm install -g` on someone's
  machine without them reading what it installs is not something this product
  does, however convenient.
- **The starter workspace is offered, not seeded.** It creates a project, a
  disabled agent, a sample page and a queued run. A workspace that arrives
  pre-populated with things you did not make is noise for anyone who already
  knows what they want. The button stays; the default is empty.
- **The dispatcher gets a banner, not a whisper**, plus a combined script that
  starts the server and the loop together. "Queued forever with no signal" is
  the worst possible first-run experience and it is currently invisible. Still
  nothing auto-starts it from a render — R3.3's reasoning stands.

### R10.4 What this costs

Mostly assembly. Already built: the runtime probe and handshake, Windows
command resolution, the runtime-aware model picker, the dispatcher heartbeat,
and starter-workspace seeding (behind a button nobody finds). Genuinely new:
the scan screen, the adapter-install action, and collapsing signup into
workspace creation.

---

## R11 — GitHub-backed projects — DEFERRED BY DECISION, reasoning kept

A project bound to a git repo could show its issues, pull requests, commits
and files, and its tasks could **be** its issues. This was designed and then
deliberately deferred; the design is recorded so whoever picks it up does not
rediscover the trap.

**Decision taken: tasks stay local and are NOT mirrored from GitHub issues.**
Task management remains simple and local. Using GitHub issues as tasks by
default for a git-backed repo is a real feature and a later one — not this
pass.

### R11.1 The rule that would make it work

If it is ever built, **every field has exactly one owner.** Not "we reconcile
conflicts" — there are no conflicts, because nothing is owned twice.

- **GitHub owns** issue title, body, open/closed, labels, assignees, comments,
  pull requests, commits, files.
- **We own** which agent is on it, its runs, its worktree, its transcripts and
  its pages.

Store a pointer (`issue_number`) and the agent layer beside it. Never copy
issue *content* into this database. That is the same decision R9 already makes
for files — **read through git, never mirror** — extended to **read through
`gh`, never mirror**. The moment an issue body is cached here and editable
here, the project has signed up for conflict resolution, webhooks, drift and
rate limits. All of it is avoided by never owning a field twice.

The one genuinely lossy mapping is the board: GitHub has open/closed, this app
has Backlog/To do/In Progress/Done. Column position would be ours (local,
instant, no API call); open/closed would be GitHub's, with a closed issue
landing in Done regardless of column.

### R11.2 What is NOT deferred

**Files and Commits are local git and need no GitHub at all**, which is
exactly why R9 sequences them first. They stay in R9 unchanged: `git ls-tree`
and `git show` for files, `readCommits` for history, blob content cached by
oid forever because a content-addressed key cannot go stale.

Issues and Pull Requests are the parts needing `gh`, an auth story and a
cache, and those are what R11 defers.

### R11.3 If it is built later

- Tabs appear **conditionally** — only when the project is bound to a repo,
  and Issues/PRs only when that repo has a GitHub remote. A local-only project
  must not grow empty tabs. (Note the tension with R7.4, which cut this page
  from eight tabs to four: those were small forms that belong in a rail, these
  would be surfaces you work in. Conditional rendering is what keeps both
  true.)
- Never `await gh` in a server component. Paint from cache, refresh after.
  `git log` is local and fast; `gh` is a process spawn and a network call, and
  they must not be treated the same way.
- An unauthenticated `gh` renders an explicit "not connected to GitHub" state,
  never an empty board — an empty list where data should be looks like data
  loss. Same honesty rule the R7 runtime-health fix applied.
- The differentiator is not showing GitHub state; GitHub already does that
  better. It is that every row is a launch point: a failing PR hands its logs
  to an agent (R5.6), an issue starts a session in a worktree on its branch, a
  commit opens in the review surface.

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
10. **R9 depends on nothing, and R5 depends on R4.** The repository browser
    reads git and renders HTML; no part of it needs the plugin layer. So it
    can be built before R5 without disturbing the ordering, and it is the
    cheapest way to make a project bound to a local repository feel real.
    Decide that deliberately rather than letting it drift forward.
11. **Shiki is a transitive dependency today.** Nothing in `package.json`
    asks for it — BlockSuite does. Promote and pin it before any of our code
    imports it directly, or a BlockSuite bump changes our rendering silently
    and a duplicate copy ships in the bundle.
12. **First run is the one path every user takes exactly once, badly.**
    R10 exists because the current empty-workspace checklist assumes the
    reader already knows what an ACP command is. Everything it needs is
    built; none of it is pointed at that moment.
13. **Do not build GitHub issue sync without the single-owner rule.** R11
    is deferred by decision, not by oversight, and its whole value is the
    rule recorded there: every field has exactly one owner, so there is
    nothing to reconcile. A bidirectional tasks-to-issues sync is the
    failure mode that rule exists to prevent.
14. **Three diff renderers will exist, and that is the intent.** The thread's
    non-throwing `DiffBlock`, the review surface's `@git-diff-view/react`,
    and R8.5's `affine:diff` block are three implementations of one concept
    serving three different densities. Anyone who tries to unify them will
    rediscover why R6.5 rejected exactly that, so the reason is recorded here
    rather than in a commit message.
