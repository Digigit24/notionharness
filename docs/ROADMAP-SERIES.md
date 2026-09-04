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


### R1.A — Audit marks: free value on the runtime layer

Tags used throughout these `*.A` sections: **[FREE-UI]** value from the
backend that already exists, **[OPTIMISTIC]** a round trip in front of a
paint, **[PERF]** a measured cost, **[EXC]** an exception path that is
silent or unhandled. Every mark names its evidence and its cost, so it can
be refused on the evidence rather than on taste.

**R1.A.1 [FREE-UI] A runtime has no defaults of its own, so "Claude's model"
must be set once per agent.** `collections/RuntimeProfiles.ts` stores the
handshake and the probe result and nothing else; the dispatcher builds a
turn's config from `agent.runtimeConfig` alone (`lib/dispatcher/worker.ts`,
`sessionConfig:` merge). Ten agents on Claude Code means setting the model
ten times, and a new agent silently gets the CLI's default instead of the
one this workspace chose. A `defaultSessionConfig` json on the profile,
merged UNDER the agent's own map, fixes it. Cost: one column, one line in
the existing merge, no new query — the profile is already loaded on that
path.

**R1.A.2 [FREE-UI] The generic settings renderer exists and is mounted in
exactly one place.** `components/runtimes/runtime-config-fields.tsx` renders
whatever options a runtime declared about itself — for Claude Code that is
`model`, `effort`, `fast`, `mode` — and it is used only by
`components/agents/agent-settings-form.tsx`. Mounting the same component
against R1.A.1's new field turns Settings → Runtimes into a real editor for
every runtime, present and future, with no runtime-specific screen.

**R1.A.3 [EXC] Probe failures are stored machine-readable and shown raw.**
`lastProbeCode` is deliberately a code (`acp_init_timeout`,
`command_not_found`, `spawn_failed`) so a log can be grepped. The UI prints
the code. Each code implies exactly one fix; say the fix. This is the
difference between "acp_init_timeout" and "the command started but never
answered the ACP handshake — check it supports `--acp`, or raise the probe
timeout".

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


### R2.A — Audit marks: identity

**R2.A.1 [OPTIMISTIC] Switching a personality profile round-trips the whole
page.** `components/personality/switch-profile-button.tsx` calls the action
and then `router.refresh()`, which re-runs the server component for a pill
whose new state is already known at click time. The same pattern appears in
23 other places (`grep -rn "router.refresh()" components/` → 24 hits);
R12-P2 handles them as a class rather than one at a time.

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


### R3.A — Audit marks: correctness and failure

**R3.A.1 [EXC] One error boundary covers the entire application.**
`app/(app)/workspace/[workspaceSlug]/error.tsx` is the only `error.tsx` in
the repo. It is a good one — it prints `error.message` verbatim rather than
"something went wrong" — but a failure in the channel, the editor, the repo
browser or the review surface takes out the whole workspace shell instead
of the one pane that broke. Segment boundaries are cheap and are the
difference between "a pane says it failed, with a retry" and "the app went
white".

**R3.A.2 [EXC] 139 swallowed catches, of which only some are deliberate.**
`grep -rn "catch {}\|\.catch(() => undefined)" components/ lib/ app/`
returns 139. A large number are correct and documented in place (a
best-effort push notification must never fail the turn that triggered it).
The rest are indistinguishable from them at a glance, which is the actual
problem: there is no way to tell a deliberate swallow from an oversight
without reading each one. R12-P1 gives them a vocabulary.

**R3.A.3 [PERF] Eleven independent polling loops, with a push channel
already built.** `grep -rn "setInterval" components/` → 11 sites.
`components/tasks/task-board.tsx` alone runs THREE four-second intervals
(metrics, presence, agent columns) and `task-drawer.tsx` a fourth; the room
polls every 6s, Work every 5s. Meanwhile `lib/broker/notify.ts`
(LISTEN/NOTIFY) and `lib/broker/live-bus.ts` + the SSE route already deliver
run events with no interval at all. D0 says a new interval is a design
failure unless the thing watched is outside the database. Two of these
genuinely are (the repo stamp, which says so in its own comment); nine are
not.

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


### R4.A — Audit marks: the plugin layer

**R4.A.1 [EXC] A broken plugin is discovered by an agent, not by the person
who configured it.** The plugin surface validates at build time for a run,
but the plugins screen shows configuration, not health. The data to show
"this server answered / refused / timed out on the last run that used it"
already passes through the dispatcher; nothing keeps it. One row per plugin
with its last outcome turns a silent misconfiguration into a visible one.

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


### R5.A — Audit marks: git review

**R5.A.1 [FREE-UI] The review surface has no loading state at all.**
`components/review/review-surface.tsx` (560 lines) contains no `Skeleton`
and no spinner: a large diff paints nothing and then everything. The file
tree and hunk list both have a known shape before the data lands, which is
exactly the case a skeleton is for.

**R5.A.2 [EXC] `lib/git/checks.ts` can fail in ways the surface cannot
say.** A missing binary, a detached HEAD, a repository that moved — all
arrive as a thrown error and are rendered as one line. Git's own stderr is
the single most useful string on that screen and it should be shown, the
way the workspace error boundary already shows `error.message`.

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


### R6.A — Audit marks: the channel

This is the pillar with the most free value left in it, because the backend
is complete and the surface in front of it is not.

**R6.A.1 [OPTIMISTIC] The composer waits for the server before it clears —
a direct D0 violation, in the one place D0 names.** D0 says: "No round trip
on the send path. Pressing Enter paints immediately… The composer already
works this way and must stay that way." It does not.
`components/teams/message-composer.tsx` `send()` does `await onSend(...)`
and only then `setBody('')`, with the whole composer at `opacity-70`
meanwhile; `components/teams/channel-view.tsx` `send` awaits
`postChannelMessageAction` before appending the row. On a warm local
database that is ~80ms and feels fine; over a real network it is the
difference between chat and a form. The message must appear the instant
Enter is pressed, with the server's row reconciling by id after.

**R6.A.2 [FREE-UI] There is a "working" indicator for agents and none for
people.** `components/teams/pending-reply-row.tsx` already draws a ghost row
for an agent that has been woken and has not answered. A person typing in
the same channel produces nothing at all. The composer already knows the
keystroke; the room already polls; the only missing piece is somewhere to
put a heartbeat.

**R6.A.3 [FREE-UI] The panes are fixed and separated by a gap.**
`thread-pane.tsx` is `w-96`, `canvas-pane.tsx` is `w-[26rem]`, and
`team-room.tsx` lays them out with `gap-4`. A thread you cannot widen is a
thread you read in a column half the width of the message it belongs to.

**R6.A.4 [PERF] The channel route ships the whole editor to read chat.**
`next build`: `/workspace/[workspaceSlug]/teams/[teamId]` is **560 kB**
first load, second only to the page canvas itself (562 kB) — because
`components/teams/canvas-pane.tsx` imports `BlockSuiteEditor` statically
while the canvas is CLOSED by default. A `next/dynamic` import moves that
weight behind the click that actually needs it. This is the single cheapest
latency win in the app.

**R6.A.5 [PERF] The room polls every six seconds for data the database can
push.** `POLL_MS = 6000` in `team-room.tsx`. `team_messages` inserts already
happen inside our own server action, so a `NOTIFY` there and a subscription
beside the run-events one removes the interval and makes a reply land in
tens of milliseconds instead of up to six seconds.

**R6.A.6 [FREE-UI] Reactions are already optimistic; nothing else in the
room is.** `applyReactionToggle` in `components/teams/shared.ts` paints
first and reconciles after — the correct pattern, already written, already
tested by `test-channels`. Claiming a task, making a task from a message,
joining the channel and marking read all still await.

---

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


### R7.A — Audit marks: panels and polish

**R7.A.1 [FREE-UI] Four loading states for thirty-five routes.**
`find app -name loading.tsx` → 4 (`workspace`, `inbox`, `tasks`,
`artifacts`); `find app -name page.tsx` → 35+. Every other route shows the
previous screen until the server component resolves, which reads as a
freeze rather than as loading. Next.js resolves this per segment with one
file each, and the shape of each screen is already known.

**R7.A.2 [FREE-UI] The settings rail already knows how to be runtime-aware,
and only does it for Hermes.** `components/settings/settings-rail.tsx` has
`hermesOnly` groups with a first-class justification for them (a Hermes
profile is a whole alternate `HERMES_HOME`). The same mechanism, pointed at
the other runtimes a workspace has enabled, gives Claude Code its own group
without inventing anything.

**R7.A.3 [FREE-UI] `useOptimistic` appears exactly once in the codebase**
(`components/sidebar/sidebar.tsx`). Twenty-five components use
`useTransition`, which makes a mutation *interruptible* but still paints
after the server. The two are not substitutes.

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


### R8.A — Audit marks: artifacts

**R8.A.1 [FREE-UI] The artifacts inbox refreshes the route to change one
row's state.** `components/artifacts/artifacts-inbox.tsx` uses
`router.refresh()` after accept/reject. The row's next state is known
locally; the refresh is a full server round trip to repaint what is already
decided.

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


### R9.A — Audit marks: the repository browser

**R9.A.1 [FREE-UI] Directory-to-file navigation shows a 14px spinner and
keeps the old content.** `components/repo/repo-browser.tsx` renders
`<Loader2>` beside the breadcrumb while `pending`. A file view has a
completely predictable shape — gutter, line numbers, code — and a shimmer of
that shape reads as "this is loading" where a spinner over stale content
reads as "this is stuck".

**R9.A.2 [EXC] Git's own stderr is the best diagnostic on the screen and is
shown as one unstyled line.** Same posture as R5.A.2: a repository that
moved, a ref that no longer exists, or a `git` that is not on PATH are three
different problems with three different fixes, and the browser currently
prints whichever string arrives.

**R9.A.3 [FREE-UI] Binary and image files have no preview path.** R9.3
called for exactly two file types to get one. A binary today renders as
whatever `readRepoView` returned; saying "binary file, 41 kB" is both
cheaper and more honest.

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


### R10.A — Audit marks: first run

**R10.A.1 [EXC] The first thing a new signup can hit is a runtime that is
not installed**, and the message they get is the probe code (R1.A.3). First
run is the one path where an unexplained failure costs the whole user, so
it is the first place R1.A.3's mapping should land.

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

---

## R12 — Ship-grade: five phases from "it works" to "it holds"

Everything in R1–R11 was about making the product DO things. This roadmap is
about what happens on the day it is used by somebody who did not build it:
when the network is slow, when git is missing, when a worktree is gone, when
two people type at once, when a runtime is not installed. None of it adds a
feature. All of it is the difference between a demo and something shippable.

The audit above (`R*.A` sections) is the evidence base. Each phase below
picks up a class of those marks and finishes it, rather than fixing them one
screen at a time — the same defect on twenty screens is one piece of work,
and treating it as twenty is how a polish pass never ends.

**Ordering is deliberate.** P1 first, because everything after it is easier
to debug once failures have names. P2 second, because it is the largest
perceived-quality gain per line changed. P3 and P4 are independent of each
other and can run in parallel. P5 last, because it is the one that benefits
most from P1's vocabulary being in place.

**D0 still outranks this roadmap.** No phase here is allowed to add a query,
a subscription or a kilobyte without saying so. Where a phase REMOVES cost,
it says how much.

---

### R12-P1 — The exception spine

Today the app has one error boundary and 139 catch blocks that all look the
same. A failure is either invisible or fatal, with almost nothing in
between, and there is no way to tell a deliberate swallow from an oversight
by reading the code.

**R12-P1.1 One failure shape, and it crosses the server-action boundary.**
A typed `AppFailure { code, message, detail?, retryable, surface }` returned
from server actions rather than thrown, with `code` a stable machine string
(`git_missing`, `worktree_gone`, `runtime_not_installed`,
`approval_forbidden`, `db_unavailable`). Thrown errors keep working — the
boundary catches them — but everything we raise ourselves gets a code a UI
can branch on and a log can be grepped for. This is the same choice
`lastProbeCode` already made and it was right there.

**R12-P1.2 A boundary per pane, not per application.** `error.tsx` for the
channel, the page canvas, the repo browser, the review surface, the settings
sections and Work; plus a small client `<PaneBoundary>` for panes that are
not route segments (thread pane, canvas pane, artifact panel). Each states
what broke, keeps the rest of the screen alive, and offers a retry that
re-runs only that pane. Cost: one file per segment, zero runtime cost until
something throws.

**R12-P1.3 Give the 139 swallows a vocabulary.** Two helpers and a rule:
`bestEffort(promise, why)` for a failure that genuinely must not propagate
(a push notification, an announcement, a read-marker), and `reportFailure()`
for one that should reach the user. A bare `catch {}` becomes a lint error.
The point is not to remove swallowing — much of it is correct — but to make
the correct ones self-describing and the accidental ones visible.

**R12-P1.4 A dispatcher failure taxonomy, written down and enforced.**
Which failures are retryable (transient pool exhaustion, a lease lost, a
worktree that can be recreated) and which are terminal (agent disabled, a
command that does not exist, a spend cap hit). This already bit us once: a
transient pool exhaustion surfaced as "Agent missing or disabled" and was
marked non-retryable, killing runs that would have succeeded on the next
tick. One table, one classifier, one test per row.

**R12-P1.5 Background failures are allowed to be quiet, not silent.** The
room's poll swallows every failure by design (a toast every six seconds is
worse than the bug). It should instead flip a single unobtrusive
"reconnecting…" state after N consecutive failures, and clear it on the
first success — the pattern `components/hermes/connection-status-banner.tsx`
already uses for the run stream.

**R12-P1.6 Logs that can be correlated.** Every dispatcher and broker log
line carries `run`, `session`, `workspace` where it has them. Today they are
prose with ids interpolated inconsistently, which makes "what happened to
run 214" a grep across three formats.

**Done when.** Stopping Postgres, removing `git` from PATH, deleting a live
worktree, disabling an agent mid-run and killing the runtime process each
produce a named, actionable message in the right pane; nothing goes white;
and `grep -rn "catch {}"` returns zero.

---

### R12-P2 — Perceived speed: shimmer, optimism, and weight

The app is fast and does not look it, because it paints nothing until it can
paint everything. This phase is almost entirely presentation over data that
already exists — the largest quality gain per line in the whole document.

**R12-P2.1 A loading state for every route.** Four of thirty-five have one.
Each `loading.tsx` is shaped like the screen it replaces — a channel shows a
header, a roster rail and six message rows; a table shows a header row and
eight cells wide; the repo browser shows a breadcrumb and a directory table.
A skeleton that does not match its screen is a second layout shift, so the
shape matters more than the animation.

**R12-P2.2 A shimmer primitive, used everywhere something is async.**
`components/ui/skeleton.tsx` exists and is `animate-pulse`. Add a `shimmer`
variant (a moving highlight, which reads as "arriving" where a pulse reads
as "waiting"), make both no-ops under `prefers-reduced-motion`, and export
composed shapes: `<SkeletonTable>`, `<SkeletonList>`, `<SkeletonCard>`,
`<SkeletonCode>`. Then use them at COMPONENT level too, not only at route
level — the agent-session block, the provenance strip, the artifact panel,
the repo file view, the review diff.

**R12-P2.3 One optimistic-mutation convention, applied to all 24
`router.refresh()` sites.** A small `useOptimisticAction` wrapper around
`useOptimistic` + the server action: paint the intended state, reconcile on
the response, roll back with a toast on failure. `applyReactionToggle` in
`components/teams/shared.ts` is the shape to generalise — it already does
exactly this and is already covered by tests.

**R12-P2.4 Stop shipping the editor to screens that do not open it.**
Measured, from `next build`: `/teams/[teamId]` is **560 kB** first load
because `canvas-pane.tsx` statically imports `BlockSuiteEditor` while the
canvas is closed by default. `next/dynamic` moves it behind the click.
Re-measure `/p/[pageId]` (562 kB) and `/tasks/[taskId]` (539 kB) after, and
record the numbers in `docs/performance-budget.md` — a budget nobody checks
is a comment.

**R12-P2.5 Nine polls become subscriptions or one poll.**
`components/tasks/task-board.tsx` runs three four-second intervals and
`task-drawer.tsx` a fourth; they can be one batched read at worst and a
NOTIFY subscription at best. The two polls that are genuinely outside the
database (the repo stamp, the relative-time ticker) stay, and say why in
place, as the repo stamp already does.

**R12-P2.6 No layout shift, anywhere.** Every skeleton reserves the exact
box its content will occupy. This is the difference between a fast app and
one that feels like it is fighting you.

**Done when.** Every route paints structure within one frame of navigation;
no mutation in the app waits for a server response before painting; the
channel route is under 250 kB; and the recorded route weights are in the
performance budget with a date.

---

### R12-P3 — The channel becomes real-time

The room's backend is finished — threads, mentions, reactions, unread,
approvals, dispatch — and its surface still behaves like a form over a
database. This phase makes it feel like the product it is.

**R12-P3.1 Optimistic send, which D0 already required.** Enter paints the
row immediately with a `sending` state, the composer clears instantly, and
the server's row reconciles by a client-generated key. A failure turns the
row red with a retry and the text is recoverable — never lost. This is
listed first because it is the one place the document's own founding rule is
violated by the code (R6.A.1).

**R12-P3.2 A typing indicator, with no rows written.** A person typing is
ephemeral state that must never touch disk: a `pg_notify` payload
(`{teamId, slotId, at}`) throttled to one per two seconds while the composer
has uncommitted text, and a client-side TTL of four seconds. Zero writes,
zero new tables, and it rides the same subscription as P3.3. The agent
equivalent already exists as `pending-reply-row.tsx`, so the two indicators
should look like siblings rather than like two features.

**R12-P3.3 Push, with the poll as the fallback.** `NOTIFY` on message
insert, reaction toggle and approval create/resolve, delivered over an SSE
route beside the existing run-events one; the six-second poll drops to a
sixty-second reconciliation sweep and to an immediate catch-up on
reconnect. Removes ~600 requests per hour per open channel and takes reply
latency from "up to 6s" to "tens of ms".

**R12-P3.4 One draggable divider, no gap.** Replace `gap-4` plus fixed
`w-96`/`w-[26rem]` with a 1px separator that is the drag handle: pointer
events with capture (not mousemove on window), `transform`-free width write
to a CSS variable so the drag stays on the compositor, min/max clamps,
double-click to reset, keyboard-resizable with arrow keys, and the width
persisted per browser the way the roster's collapsed state now is. The same
component serves the thread pane and the canvas pane.

**R12-P3.5 Everything ephemeral rides the same channel.** The approval
strip, the ghost rows, the unread divider and the roster's liveness all
consume the one subscription rather than each finding its own way to be
current.

**R12-P3.6 Send failures are recoverable, not silent.** A failed send keeps
its text, offers retry, and survives a reload as a local draft.

**Done when.** Two browsers, one channel: typing shows within 200ms, a
message appears instantly for the sender and within 300ms for the other,
dragging the divider holds 60fps with the thread open, and pulling the
network for 30s produces a "reconnecting" state that self-heals with no lost
messages.

---

### R12-P4 — Settings that match how the product actually works

Settings today is a good rail in front of a Hermes-shaped model. A workspace
running Claude Code has one screen that acknowledges it (Providers) and no
way to set what that runtime should do by default.

**R12-P4.1 A runtime has defaults.** `defaultSessionConfig` on
`runtime-profiles`, merged UNDER `agent.runtimeConfig` in the dispatcher's
existing merge (R1.A.1). Precedence becomes: runtime default → agent →
per-turn override. One column, one line, no new query.

**R12-P4.2 A runtime detail screen with real edit operations.** Settings →
Runtimes → a runtime opens its own panel: identity and command, the
generic `RuntimeConfigFields` bound to P4.1's defaults (so "Claude's default
model" is one control in one place), the probe result with a retry, the
handshake it declared, and the agents currently using it. No
Claude-specific code — the runtime declares its own options and always has.

**R12-P4.3 The rail groups per runtime, not per vendor.** `hermesOnly`
generalises to "shown when this workspace has an enabled runtime of kind X".
Hermes keeps its group and its justification; Claude gets one; a third
runtime added later gets one for free.

**R12-P4.4 Precedence is visible where it applies.** On the agent editor, a
field left unset shows the value it will actually inherit and where from
("model — inheriting `sonnet` from the Claude Code runtime"). An inherited
default that is invisible is the same bug as no default at all.

**R12-P4.5 Probe codes become sentences with a fix.** One map from code to
"what this means / what to do", used by the runtimes screen, the agent
editor and first run (R1.A.3, R10.A.1).

**R12-P4.6 The settings hygiene pass.** Optimistic saves (P2.3), an
unsaved-changes guard, inline validation, and a search box over the rail —
twelve sections is past the point where scanning is reliable.

**Done when.** Changing the default model on the Claude Code runtime changes
every agent that has not overridden it, a new agent inherits it without
being told, and no screen in Settings requires knowing which runtime the
screen was designed against.

---

### R12-P5 — Repo, git, worktrees, orchestration: nothing breaks

The most dangerous surface in the product, because it runs external
processes against real repositories, and the failure modes are other
people's code, other people's disks and other people's git versions.

**R12-P5.1 One git invocation path, hardened.** Today `execFile('git', …)`
appears in `lib/git/*` and `lib/run-worktrees/manager.ts` with different
error handling in each. One helper: explicit `cwd`, a timeout, `windowsHide`,
captured stderr, a maximum buffer, and typed failures mapped to P1.1 codes
(`git_missing`, `not_a_repository`, `bad_ref`, `timeout`). Every caller
keeps its own logic; none of them re-invents this.

**R12-P5.2 The worktree lifecycle survives a crash on any step.**
`manager.create` is awaited unguarded on the dispatcher's hot path
(`lib/dispatcher/worker.ts`): a clone that fails takes the run with it, with
whatever message git produced. It needs: a typed failure, a retry for the
transient half (fetch), an orphan reaper on boot (`worktree prune` plus
removal of `agent/run/*` branches with no run row), a disk budget honoured
by `retention.ts`, and a refusal to remove a worktree holding uncommitted
work without saying so.

**R12-P5.3 The mutex is per-process, and that must be true or fixed.**
`lib/run-worktrees/manager.ts` says "the mutex is in-process by design". It
is correct only while exactly one Node process touches a given bare clone.
A dev server and a prod server on one machine, or two dispatcher workers,
break it. Either take a Postgres advisory lock keyed on the bare path — we
already have the pool — or make the single-worker invariant explicit and
enforced at boot rather than assumed in a comment.

**R12-P5.4 Orchestration is verified by killing it, not by reading it.** A
chaos script that: kills the worker mid-turn (lease recovery), cancels a run
(`cancel_requested_at` is honoured), saturates the per-agent ceiling,
exhausts the pool, and times out an approval. Each has a defined outcome;
each gets a test. Half of these have been fixed once already after being
found by hand — that is the argument for automating them.

**R12-P5.5 The file viewer handles the files that actually exist.** Large
files (cap and say so), binary (name it, do not render it), images (preview
— R9.3 asked for exactly two types), symlinks, submodules, CRLF, non-UTF8
encodings, and a ref that vanished between the listing and the click.

**R12-P5.6 Destructive operations announce themselves.** Nothing removes a
worktree, resets a branch or discards changes without a sentence naming what
is about to be lost. This is the one place in the product where a silent
success is worse than a loud refusal.

**Done when.** The chaos script runs green; a repository with a 40 MB
binary, a submodule and a symlink browses without an error; removing git
from PATH produces "git is not installed or not on PATH" everywhere it is
needed and nowhere else; and no run can be killed by a failure that is
recoverable.

---

## R13 — Pages: Notion parity where it is still missing, in three phases

Two complaints drive this, and both are about the same thing: the database
block is the centre of a Notion-like product, and ours is closer to a grid
than to Notion's property system. Relations exist and do not feel finished;
formula and rollup do not exist at all; and every async surface in the
editor paints empty before it paints content.

The BlockSuite decision from R6.5 stands: documents are BlockSuite, feeds
are not. Nothing here reopens that.

---

### R13-P1 — The table you can trust

**R13-P1.1 The table shows its shape before its data.** The native database
block renders empty and fills; with a remote data source that is a visible
flash of nothing. A header row plus eight ghost rows, sized from the column
widths the view already knows, using P2.2's shimmer.

**R13-P1.2 Rows virtualise and columns hold their width.** D0's "no
unbounded lists" applies to tables as much as to feeds. Column widths
persist per view; resizing does not reflow the page.

**R13-P1.3 Relations feel finished.** `relation-property.ts` and
`user-database-data-source.ts` already implement the hard half — picking a
target database, two-way mirroring, bidirectional visibility. What is
missing is the surface: a searchable picker, create-and-link in one step,
chip removal without opening a panel, a visible one-way/two-way state, and a
clear message when the target row was deleted.

**R13-P1.4 Cell editing survives real use.** Enter commits and moves down,
Tab commits and moves right, Escape reverts, paste of a multi-cell region
fills a range, undo covers a cell edit rather than only a block edit, and
multi-select delete asks once rather than per cell.

**R13-P1.5 A row page IS its row.** The record header now renders (it was
comparing `'user-database'` against a stored `'userDatabase'` and had never
appeared once), but the page's own title should be the row's title property,
kept in sync both ways, so a row page opens as "Q3 pricing" and never as
"record aojhfiefhh".

**R13-P1.6 Cell writes are optimistic.** Same convention as R12-P2.3. A cell
that waits for a round trip before showing what you typed is the single most
noticeable lag in a table.

**Done when.** A 2,000-row database opens with structure in one frame,
scrolls at 60fps, and every edit paints before the network.

---

### R13-P2 — The property system: formula, rollup, and the rest

**R13-P2.1 An explicit parity inventory, with edge cases.** Enumerate
Notion's property types against ours, and for each one the edge cases that
make it real rather than nominal: an empty value versus a zero, a select
option renamed while rows reference it, a date with and without a time and
with a range, a number's format, a person who left the workspace. The
inventory is the deliverable of this step — building against a vague "like
Notion" is how half-types get shipped.

**R13-P2.2 Formula.** A small, total expression language (no loops, no I/O):
references to other properties, arithmetic, string and date functions,
`if`/`and`/`or`, and typed results. A dependency graph per database with
cycle detection at definition time, so a cycle is refused when it is written
rather than discovered when it is evaluated. Errors render in the cell as an
error, never as a crash and never as a blank.

**R13-P2.3 Rollup.** Relation property + target property + aggregation
(count, sum, min, max, average, unique, show original, percent empty). It
composes with formula, which means the dependency graph from P2.2 has to
span databases, and that is the design constraint to settle before any code.

**R13-P2.4 Where evaluation runs — a D0 decision, taken deliberately.**
Client-side evaluation for immediate feedback while typing; server-side
evaluation on write for the stored value, so a row read by an agent through
MCP or by another database's rollup sees the same number the human sees.
Cached in `cells` under a reserved key, invalidated by the dependency graph.
Never recomputed on read for a list of rows — that is the N+1 D0 forbids.

**R13-P2.5 The remaining types.** Person, files and media, created/edited
by, created/edited time, status (which is not select — it has groups), and
unique id.

**R13-P2.6 Migration without a stop-the-world.** `database-rows.cells` is a
flat json map and the schema is a json array on the parent — chosen exactly
so this kind of change is additive. New property types must read old rows
with no backfill, and any backfill that IS needed runs lazily on read.

**Done when.** A database with a relation to a second database, a rollup
over it and a formula over the rollup recomputes correctly when the far row
changes, in one write, with no read-time recomputation.

---

### R13-P3 — Views, and no lag anywhere in the editor

**R13-P3.1 Filters, sorts and groups, saved per view.** `collections/
SavedViews.ts` already exists; the surface does not use it for the native
database block.

**R13-P3.2 Board, gallery and calendar over the same source.**
`kanban-board.tsx` exists standalone; it should be a view of a database
rather than a separate component with its own data path.

**R13-P3.3 The editor's first paint.** `/p/[pageId]` is 562 kB. Split the
editor from the page shell so the title, the origin header and the
properties paint immediately and the canvas hydrates after; measure and
record.

**R13-P3.4 Every async block shows a shape.** The agent-session block, the
provenance strip, mentions and the suggestion bar all currently paint empty
first. Same primitives as R12-P2.2.

**R13-P3.5 Keyboard and accessibility.** Full keyboard navigation of a
table (arrows, Home/End, page keys), focus visible everywhere, roles correct
on the grid, and the drag handles from R12-P3.4 operable without a mouse.

**R13-P3.6 A perf budget that fails the build.** Route weight and
first-paint numbers recorded in `docs/performance-budget.md` with a
threshold; a pull request that crosses it says so.

**Done when.** Opening a page with a 2,000-row database, a relation and a
rollup shows structure in one frame, is interactive in under a second on a
cold cache, and nothing in the editor paints empty before it paints content.

---

## R14 — Channels: Slack parity, and the ten things Slack cannot do

R6 built a channel and R12-P3 makes it real-time. Both stop at the point
where a person who has used Slack for ten years opens ours and starts
reaching for things that are not there. This pillar is that list, taken from
the code rather than from a feature matrix: every item below names the
table, file or dependency it lands on, and none of them needs a dependency
we do not already ship.

Two things are true at once and this pillar holds both. First, the channel
is missing table stakes — message search, edit, pins, DMs — and no amount of
agent cleverness covers for their absence. Second, because the coworkers in
this channel are metered, run in worktrees, produce diffs and wait on
approvals, we can show things in a message row that Slack structurally
cannot. P1–P5 are parity. P6 is the part that is only possible here.

**What already exists, and is NOT re-specified below.** Threads, reactions,
mentions of users/agents/teams, per-slot unread high-water marks, dead
letters, the approval strip, slash commands (`/task /assign /canvas
/status`), board/lanes/canvas views, optimistic send (R12-P3.1), typing
indicators (R12-P3.2), NOTIFY/SSE push with the poll as fallback
(R12-P3.3), and local drafts (R12-P3.6). Anything in this pillar that needs
ephemeral fan-out rides the R12-P3.3 subscription and adds no second one.

**Effort marks.** S = hours, M = one to two days, L = three to five days.
Every item carries one, and the pillar's honest total is roughly six to
eight weeks of one person's time with P6 included, four without.

**D0 applies.** No item may add a per-message query. Where an item adds a
column, the `MESSAGE_SELECT` lateral in `lib/broker/channels.ts` grows one
join, not one round trip.

---

### R14-P1 — Table stakes: find it, fix it, keep it

**R14-P1.1 Message search — S/M.** `lib/search.ts` indexes pages, tasks,
projects, agents, comments, run transcripts and skills, and not
`team_messages` — the one table people actually ask "where did someone say
X" about. Same live `to_tsvector` pattern as the others, a "Messages" group
in the command bar, and `in:#channel from:@name before:` filters parsed
client-side into the query. Results deep-link by message id (P1.4).

**R14-P1.2 Edit and delete — S.** `edited_at` and `deleted_at` on
`team_messages`; a deleted row is a tombstone ("message deleted") so thread
replies keep their parent. The hover action bar in
`components/teams/message-row.tsx` gains two actions. Only the authoring
slot may edit or delete, and an agent slot never edits a human's row. An
edit is a new `body` and a marker, not a new row — the id is what pins,
links and tasks point at.

**R14-P1.3 Pins — S.** `team_message_pins(team_id, message_id, pinned_by,
pinned_at)`, a pin action on the row, and a Pins tab in
`components/teams/roster-panel.tsx`, which already has tabs. A pinned row
shows a small marker in the feed. Newcomers to a channel read the pins
first; this is the cheapest onboarding feature that exists.

**R14-P1.4 Permalinks, quote and share — S.** "Copy link" produces
`/teams/<id>#m=<messageId>`; the room already `scrollIntoView`s the first
unread, so landing on an anchor is the same code path with a highlight
flash. "Share to channel" posts a new message carrying `quoted_message_id`,
rendered as a quoted card above the body. The quote is a reference, not a
copy, so an edit to the original shows through.

**R14-P1.5 Channel details — S.** `topic`, `description` and `archived_at`
on `teams`. Topic in the channel header; an About tab in the roster panel
with created-by, members and roles, Leave and Archive. The create dialog
gains two optional fields. An archived channel is read-only and drops out
of the sidebar's default list, and nothing in it is deleted.

**R14-P1.6 Mute and notification level — S.** Per-slot `notify_level`:
`all | mentions | none`. The sidebar counter (`components/sidebar/
channels-data.ts`) and `lib/push/send.ts` both read it, so a muted channel
neither badges nor pushes. Today every channel shouts equally, which is the
same as none of them being heard.

**R14-P1.7 Emoji picker, autocomplete and custom emoji — S/M.** Reactions
work; the picker does not exist. A picker with search and a recently-used
row; `:thu` autocomplete in the composer using the same palette component
the mention and slash menus use; a workspace `emoji` upload collection for
custom ones, rendered by short name.

**Done when.** A word said once in any channel three months ago is found
from the command bar in under a second, a typo is fixed without a
follow-up message, a channel's three most important messages are one tab
away, and a muted channel is silent on every device.

---

### R14-P2 — People: where they are, and how to reach one of them

**R14-P2.1 Direct messages and group DMs — M.** The schema reserved this in
migration 0013: a DM is a channel of two (or a few), never a second meaning
for `to_slot_id`. A team with `kind = 'dm'`, member slots for each person,
no name, no create dialog — a "Message" action on a person anywhere in the
app finds or creates it. Own sidebar section, sorted by last activity.
Threads, reactions, unread, search and pins come for free because it is
the same table.

**R14-P2.2 Presence — S.** `last_seen_at` on the viewer's slot, written by
the R12-P3.3 heartbeat that already exists for reconnect, never by a
dedicated request. Online within two minutes, away after, and the value is
delivered on the same subscription as everything else — zero new
infrastructure. See P6.7 for what agent presence becomes.

**R14-P2.3 Custom status and Do Not Disturb — S.** `status_emoji`,
`status_text`, `status_expires_at`, `dnd_until` on `users`. Status shows
beside the name in the roster and on mention hover. `sendPushToUser` is the
single push entry point; one check against `dnd_until` before it sends,
and the notification is still written so nothing is lost. The
notification-preferences page already exists to host the controls.

**R14-P2.4 The Activity view — M.** `listUserMentions` exists and
`components/inbox/inbox-list.tsx` is the surface. Three tabs: Mentions,
Threads (every thread the viewer posted in, with unread reply counts — one
query over `thread_root_id`), and Reactions (to the viewer's messages).
Thread replies gain an "also send to #channel" checkbox, and a reply sent
that way is one row with a `thread_root_id` AND a broadcast flag, not two
rows.

**R14-P2.5 Sidebar sections, stars and reorder — M.** Favourites already
exist for pages; extend the flag to teams. A per-user sidebar layout
(custom sections, collapsed state, order) stored as one JSON document in
`SavedViews`, which already exists, with `@dnd-kit` — already a dependency
— for the drag. Unread and mention counts roll up to a collapsed section.

**R14-P2.6 Keyboard-first — S/M.** `lib/keyboard` and the command bar
exist. Cmd+K jumps to channels and DMs alongside pages; Alt+↑/↓ next
channel; Alt+Shift+↓ next unread; Esc marks the channel read; ↑ in an
empty composer edits the viewer's last message (P1.2). Power users judge a
chat surface on this alone.

**Done when.** Two people can talk without creating a channel, a person's
absence is visible before a message is sent to them, and a full day in
channels is possible without touching the mouse.

---

### R14-P3 — Time: later, and on a schedule

**R14-P3.1 Reminders — M.** `reminders(user_id, entity_type, entity_id,
fire_at, fired_at)`, created from any message, page, task or run: 20
minutes, 1 hour, tomorrow 09:00, custom. The dispatcher tick already loops;
it delivers due reminders as a Notification plus `sendPushToUser`. No
Hermes cron, no second scheduler — the mechanism exists.

**R14-P3.2 Scheduled send — S.** A message row with `send_at` in the future
is excluded from `listChannelFeed` and posted by the same tick when due.
The composer gains a caret beside Send with the P3.1 presets; a scheduled
message sits in a "Scheduled" strip above the composer where it can be
edited or cancelled. Reuses P3.1's mechanism entirely.

**R14-P3.3 Saved items — M.** `saved_items(user_id, entity_type,
entity_id, saved_at)` across messages, pages, tasks and runs; a bookmark
action on each; a Saved tab in the Inbox. `lib/entity-links.ts` already
turns any of those into a card, so the list is a query and a map. Slack
calls this "Later"; it is the single feature most people say they cannot
work without.

**Done when.** "Remind me about this thread tomorrow" is two clicks, a
message written at midnight lands at nine, and a saved list survives a
reload on another device.

---

### R14-P4 — Rich messages: what a body can carry

**R14-P4.1 Markdown-lite — M.** Bold, italic, inline code, fenced code
blocks, quotes and lists, rendered by a small deterministic renderer —
NOT BlockSuite, which R6.5 reserved for documents. `shiki` is already a
dependency for highlighting. Cmd+B/I and ``` toggling in the composer.
Agent messages already arrive in markdown and are shown raw today; this
fixes both authors at once.

**R14-P4.2 Attachments — M.** Payload upload collections and `sharp` are
installed; `components/thread/Attachment.tsx` already renders attachments
for agent threads. Drag-drop or paste into the composer creates a media
document and an `attachments` array on the message; images inline at a
bounded height, files as chips with size and type. Access follows the
channel's access, not the file's.

**R14-P4.3 Link unfurls — M.** Internal first: a pasted page, task, run or
message URL becomes a card, and `lib/entity-links.server.ts` already
resolves those. External: a server action that fetches OpenGraph tags into
an `unfurls(url, title, description, image, fetched_at)` cache table with a
size and time cap, so one paste is one fetch and the feed never fetches.
Unfurl on send, never on render — D0.

**Done when.** A code snippet, a screenshot and a link to a task all look
like what they are, and none of them costs the feed a render-time request.

---

### R14-P5 — The workflow builder — L

Slack's Workflow Builder is a form over triggers and actions. Every trigger
and every action it offers already exists here as code: new message in a
channel, a reaction added, a schedule (Hermes crons), a task changing
status (the dispatcher), a run finishing; and post a message, create a
task, assign it, start an agent, send a push. What is missing is the table
and the form.

`workflows(team_id, trigger, condition, action, enabled, created_by)` with
a settings page of trigger → condition → action rows, and one function in
the dispatcher tick that evaluates enabled workflows against the events it
already sees. Conditions are a small, closed set (message matches, reaction
is, status becomes, from slot is) — no expression language. This is the one
L item in the pillar and it makes P6.9 and P6.10 configuration rather than
features.

**Done when.** "When someone reacts 🎫 in #support, open a task assigned to
@triage and reply in thread with the link" is built by a non-engineer in
under a minute and runs without anyone restarting anything.

---

### R14-P6 — What Slack cannot do, and we can for almost nothing

None of these is a moonshot. Each one is a column or a chip in front of
something the harness already records because agents, not people, wrote
the messages.

**R14-P6.1 Expand-to-diff on agent messages — S.** Every agent message
carries `run_id`; `@git-diff-view/react` and `lib/hermes/unified-diff.ts`
already render diffs. An agent's "done, refactored the auth module" gains
a disclosure that unfolds the actual diff beneath the row, fetched on
expand only. Slack shows words. We show the work.

**R14-P6.2 Approve or deny from the push notification — S.** `web-push`
supports action buttons and the `approval` push event already exists. Two
buttons on the lock screen resolve the approval through the existing
approvals route without opening the app. No chat product can do this,
because no chat product owns the agent runtime.

**R14-P6.3 Promote a thread to a page — S/M.** One action turns a thread
into a BlockSuite page, with `lib/provenance.ts` stamping which message
each block came from and who wrote it. Slack Canvas is a document that
forgets where it came from; ours is a live CRDT page with native databases
and a back-link to the conversation that produced it.

**R14-P6.4 Ask the workspace, with citations — S (after P1.1).**
`components/ask/ask-view.tsx` and transcript search exist. Slack sells
this as a paid add-on; here it is a search over messages, pages and run
transcripts plus a prompt. "What did we decide about rate limiting" answers
with the thread, the page and the run that implemented it, each linked.

**R14-P6.5 A cost meter per channel, thread and agent — S.**
`lib/broker/usage.ts` already meters tokens per run. A chip in the channel
header — spend today, tokens — with drill-down per agent and per thread.
Coworkers that are billed by the token should have a price on the wall.

**R14-P6.6 `/term` — a shared terminal in the channel — M.** `node-pty` and
`components/thread/TerminalBlock.tsx` exist. `/term` opens a pane bound to
the team's worktree that every member sees live and the room's leader may
type into; it closes with the pane and leaves a transcript row. A "let me
show you" for engineering that a voice huddle cannot be.

**R14-P6.7 Diagnostic presence — S.** Slack presence is a green dot. An
agent slot's dot reads from run status and the reliability tables that
already exist: "working on #142 · 3 min", "waiting for your approval",
"failed — dead-lettered". The roster dot and its tooltip, nothing more.

**R14-P6.8 Two-way task chip on messages — S.** `/task` creates a task
from a message and `TaskLinks` records the pair. The chip on the message
now shows the task's live status and moves when the board moves. Slack
Lists link one way and go stale; here the chat row is a view of the task.

**R14-P6.9 Reaction as command — S, or P5 configuration.** 👀 claims a
message for triage, ✅ closes its linked task, 🤖 hands it to the channel's
leader agent, 📌 pins it. The reactions table exists; the dispatcher tick
reads new reactions and acts. Each of these is a paid workflow in Slack.

**R14-P6.10 Scheduled agent stand-ups — S.** Hermes crons exist. "Every
weekday 09:00, @scribe posts what changed in #eng" — from worktree
commits, closed tasks and dead-lettered runs — is a cron whose prompt
template is the whole feature. A Slack workflow posts static text; this
posts a synthesised, linked report.

**Done when.** A person watching a channel for one minute can see what an
agent changed, what it cost, what it is waiting on, and approve it from
their phone — without opening a second tab.

---

### R14 — Ordering, and why

1. **P1.1 search, then P6.4 ask** — search is the base and the second is a
   prompt over it.
2. **P1.2, P1.3, P1.4** — edit, pins, permalinks: all S, all table stakes,
   all done in one sitting.
3. **P2.2 and P6.7 together** — human and diagnostic presence share the
   heartbeat; build them as siblings.
4. **P3.1 then P3.2** — reminders and scheduled send are one mechanism.
5. **P6.1 and P6.2** — expand-to-diff and approve-from-push are the demo
   that makes someone say "this is not Slack".
6. **P2.1 DMs** — the schema has been waiting since 0013.
7. Everything else in phase order; P5 last, once the triggers it wraps have
   all been exercised by hand.

**Not in this pillar.** Voice or video (a WebRTC signalling server is a
different product); Slack Connect between workspaces (R11's reasoning
applies — a sync problem, not a chat one); a message-level CRDT (D0, R6.5
and the R12/R13 exclusions all stand — the feed stays a list of rows).

---

## What these three roadmaps do NOT include, deliberately

- **No new product surface.** Not one of these phases adds a feature. If a
  phase finds itself designing a screen that does not exist yet, it has
  drifted.
  R14 is the deliberate exception: it is the one pillar whose purpose IS
  new surface, and it is bounded by its own "Not in this pillar" list.
- **No GitHub sync.** R11 stays deferred, for the reason recorded there.
- **No CRDT anywhere new.** R13 touches tables and properties; it does not
  move a feed into Yjs. D0's first rule is unchanged.
- **No abstraction for its own sake.** R12-P5.1 unifies git invocation
  because there is one correct way to run a subprocess; it does not unify
  the three diff renderers, for the reason recorded in blocker 14.
- **No second agent transport.** See the appendix below.

---

## Appendix — options considered and NOT adopted

Nothing in this appendix is work. It is not a backlog, not a "later" list and
not a phase. No agent, human or otherwise, should begin any of it on the
strength of it appearing here; it exists so that a question already answered
does not get re-litigated from scratch in six months. Acting on any of it
requires someone explicitly asking for it by name.

### A1 — Driving Claude Code through the Agent SDK instead of ACP

**The question.** Can our UI show what happens INSIDE a Claude Code subagent —
a live child thread per spawned agent, the way the Claude Code terminal draws
its own panes?

**What was established, from the code rather than from assumption.** The ACP
schema (`@agentclientprotocol/sdk`, `dist/schema/types.gen.d.ts`) declares
fifteen `sessionUpdate` variants:

    agent_message_chunk      agent_thought_chunk      available_commands_update
    compaction_summary_chunk compaction_update        config_option_update
    current_mode_update      plan                     plan_removed
    plan_update              session_info_update      tool_call
    tool_call_update         usage_update             user_message_chunk

A search of that file for `subagent`, `sub_agent`, `child_session` or `nested`
returns nothing. **ACP has no concept of a child agent stream.** Over our
current transport a Claude subagent can only arrive as a `tool_call` for the
Task tool plus its `tool_call_update` — enough for an expandable card showing
the prompt, status and result, and not enough for a live nested thread.

**The option not taken.** Anthropic's Agent SDK is a genuinely richer stream
for Claude specifically, and would plausibly carry subagent lifecycle events
that ACP does not model. That is a real capability and it is the honest reason
this appendix exists rather than a flat "impossible".

**Why it is not adopted.** It would make the harness Claude-only. D1 is the
load-bearing decision of this entire series — *ACP is the interface; adding a
CLI is data, not code* — and the Agent SDK drives Claude Code and nothing
else. Hermes, and any future Codex, Gemini or Qwen, would need a second
driver, at which point we own two agent loops with two event models and the
abstraction D1 exists to avoid has been rebuilt as a fork in the road. A
per-runtime feature that costs runtime neutrality is the wrong trade at this
size.

**What would change the answer.** Someone deciding that Claude Code is the
only runtime that matters commercially, or ACP gaining a child-session update
in a later revision of the schema. Neither is true today. If the first ever
becomes true, this is a design to reopen deliberately, not to drift into.

**The cheap thing that settles it empirically**, if anybody ever wants it: log
raw `session/update` payloads for one turn in which Claude demonstrably spawns
a subagent, and look for nested tool calls or any child identifier.
`normaliseSessionUpdate` ends in `default: return null`, so a non-standard
field the adapter already emits would currently be discarded unseen. Roughly
twenty lines, and it converts this appendix from schema reading into an
observation.

### A2 — Update kinds we receive and discard (NOT part of A1, and separable)

Noted here only because it was found while investigating A1, and it is a
different, smaller thing: `normaliseSessionUpdate` handles eight of the
fifteen variants above and returns `null` for the other seven —
`available_commands_update`, `compaction_summary_chunk`, `compaction_update`,
`config_option_update`, `current_mode_update`, `plan_removed` and
`plan_update`.

Two of those have visible consequences. `plan` is rendered but `plan_update`
and `plan_removed` are not, so a plan the agent revises mid-turn never changes
on screen. And `compaction_update` is the agent stating that it has just
compacted its own context — which is precisely the event that explains an
agent losing track of work it did earlier in a long run.

This is signal already being paid for and thrown away. It needs no transport
decision and no part of A1. It is still not scheduled work.
