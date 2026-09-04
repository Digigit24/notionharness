# Handoff — from a single-owner local app to something a paying team can use

Written 2026-09-04 against commit `b3efba8`. Every claim about *this
repository* was read out of the code on that date and carries a file
reference. Every claim about a *third-party* product — Better Auth's
organisation plugin, Composio's API, Composio's pricing — is marked with the
date it was checked, and where I could not confirm something it is marked
**VERIFY** rather than asserted. A confident wrong sentence about somebody
else's API is the most expensive thing this document could contain, so the
uncertain parts say that they are uncertain.

Companion to `docs/ROADMAP-SERIES.md`, not a replacement. That document decides
how the *harness* is built. This one decides who is allowed to use it and whose
credentials it acts with. Where the two touch — D0's latency rule, D4's
ownership boundary, R4's plugin layer, R11's single-owner rule, R12-P4's
runtime defaults — this document defers to it and cites it.

---

## 1. What exists today

### The honest summary, before the table

Three sentences, and they are the reason this document exists.

**Tenancy today is single-tenant with a guest list.** A workspace has one
`owner` and a flat `members` array. Everyone in it sees every project, every
agent, every plugin and every credential. That is the correct amount of model
for one person running this on their own machine, which is exactly what it is.
It is not a shrunken multi-tenant model; it is a different model, and the work
below is addition rather than adjustment.

**The agent side is in better shape than the human side.** The run-token
discipline (minted at claim, dead at settle, one authorisation rule across
four endpoints), the `{{RUN_TOKEN}}` substitution that keeps live credentials
out of database rows, and the out-of-scope-rather-than-blank rule in
`lib/plugins/resolve.ts` are all things most products get wrong and this one
got right. Everything proposed in §4 is built *on* those, not over them.

**The human side has one good file and almost nothing else.**
`app/(app)/workspace/[workspaceSlug]/teams/actions.ts` was written with a real
threat model, and its header comment enumerates its own four guards. It is not
a gap — it is the template the rest of the app should have been built from.
Outside it, authorisation ranges from partial to entirely absent, and in
several places a server action or route is reachable by an unauthenticated
request.

### The table

| Capability | Where it lives | What it actually enforces | What it does NOT |
|---|---|---|---|
| Login / sessions | `lib/auth.ts`, `lib/session.ts`, `app/(auth)/login`, `app/(auth)/signup` | **Better Auth `^1.4.22` is already the auth library**, on its own pg pool (`max: 2`) against the same Postgres. Email + password only (`emailAndPassword: { enabled: true }`). Better Auth owns `user`/`session`/`account`/`verification` | No OAuth/SSO, no email verification, no password reset, no MFA, no organisation plugin, **no email transport anywhere in the repo**, and **no `middleware.ts` at all** — there is no route-level protection, every check is per-page or per-action |
| App user identity | `lib/current-user.ts` | Lazily find-or-creates a **Payload `users` row shadowing the Better Auth session, joined by email**, with a throwaway random password and `role: 'member'`. Every app relationship points at the *Payload integer id*, never Better Auth's text id | The two id spaces are joined by **email string equality and nothing else** — no stored key. An email change desynchronises them silently |
| Global role | `collections/Users.ts:24` | `role: 'admin' \| 'member'`, **global, not per-workspace**. Read in exactly one place in the repository: `collections/Workspaces.ts:14` | No per-workspace, per-project or per-channel role. (`role: 'leader'` in `lib/broker/teams.ts` is a channel *slot label* used for prompt text and badges; no guard reads it. `role: 'primary'` on `ProjectResources` is a resource kind) |
| Tenancy | `collections/Workspaces.ts` | `owner` (one user) + `members` (many). That is the entire model | No organisation, no billing entity, no role inside a workspace |
| Workspace access check | `app/(app)/workspace/[workspaceSlug]/layout.tsx` ~L40–46 | Owner-or-member, `notFound()` on failure so a stranger cannot distinguish "not yours" from "no such slug". Its comment records that this **used to be entirely absent** | Guards *rendering only*. A server action is reachable without ever rendering this layout |
| Workspace lookup | `lib/pages-cache.ts:14` | Nothing — `overrideAccess: true`, resolves a slug. Honest about it (`.../projects/[projectId]/files/actions.ts:77` says so) | It is not an authorisation function, and much of the app uses it as if it were |
| Server actions | ~30 `'use server'` files under `app/` | **One file does it properly** — `teams/actions.ts` (`requireUser` L108, `requireWorkspace` L122, `requireChannel` L144, `requireAccess` L158, `requireSlot` L166, `requireAgent` L180, `requireWorkspaceUsers` L205), applied to every export. Three others check membership: `projects/[projectId]/files/actions.ts`, `work/git-actions.ts`, and the page paths in `app/(app)/actions.ts` | A second tier checks the session only and then trusts a client-supplied `workspaceId` (`work/actions.ts`, all six `settings/*/actions.ts`, `ask`, `agents`, `tasks/[taskId]`, `runs/[runId]/review`). A **third tier has no session check at all**: `settings/actions.ts:23 updateSpendCap`, `settings/personality/actions.ts:12 switchActiveHermesProfile`, `projects/actions.ts:12 createProject`, `projects/[projectId]/actions.ts` (all five), `command-bar/actions.ts` (all seven, including `listAssignableUsers` which discloses any workspace's member identities), and most of `tasks/actions.ts`. In `tasks/actions.ts` the pattern `context: { actorId: user?.id }` reads like a guard on a skim and is attribution only |
| Agent writes | `agents/actions.ts:29 saveAgent` | Nothing. No session check, no workspace check, and **no field whitelist** — `payload.update`/`create` with `overrideAccess: true` on whatever keys the client sent | — |
| Payload REST/GraphQL | `app/(payload)/api/[...slug]`, `.../graphql` | `collections/Workspaces.ts` is **the only collection with an `access` block** (1 of 23). Payload defaults the other 22 to `() => true` for every operation | Unauthenticated read/create/update/delete on `Users`, `Plugins` (which holds third-party tokens by design), `RuntimeProfiles` (command wiring), `Agents`, `Activity` (the audit log), `Approvals`, `Pages`, `Tasks` and the rest. `Workspaces.ts:3-13` documents this exact class of bug and says the fix was applied to that one collection only |
| API routes | `app/api/**` | Correct: `/api/approvals` (401 + `requestedUser` 403), `/api/runs/[id]/events/stream` (401 + `userCanReadRun`), `/api/pages/[id]/live-state`, `/api/notifications/subscribe`. Run-token authenticated: the four MCP/daemon endpoints below | **Unauthenticated**: `POST /api/dispatcher/tick` (drives the whole dispatcher; no shared secret exists in the repo to check against — `DISPATCHER_SECRET` has zero matches), all sixteen `/api/hermes/**` routes including `skills/save`, `skills/delete` and `crons/run` (host-side file writes and job execution), `/api/search` (full-text over **all** pages, `workspaceId` optional), `/api/agents`, `/api/runs/[id]`, `/api/user-databases/**`, `/api/payload-datasource/[collection]/records/[id]` (**PATCH and DELETE**), `/api/pages/[id]/sync`, `/api/pages/[id]/import-markdown`, `/api/runtimes/health-check` |
| Channels / teams | `lib/broker/teams.ts`, migrations `0009_teams.sql`, `0013_channels.sql` | `team_members` is a slot backed by **an agent XOR a user** (`team_members_agent_xor_user`, a real CHECK). `teams.is_private` + `isChannelMember` gate a private room, refusing with `not_found` rather than `forbidden` so a probe cannot confirm existence | **No invite flow anywhere.** Grepping the repository for `invit` returns one hit, in an unrelated docstring. A roster is set from people who can already open the workspace. No leader guard — a plain member can perform leader-slot mutations |
| Projects | `collections/Projects.ts`, `ProjectResources.ts` | A `workspace` relationship. That is all | No owner, no members, no ACL, no visibility. Every project is visible to every workspace member. `createProject` / `updateProject` / `deleteProjectResource` are unauthenticated server actions |
| Agents | `collections/Agents.ts` | Workspace-scoped rows: `skills`, `mcpConfig`, `runtimeConfig`, `permissionMode` (`ask`/`auto`/`deny`), `maxConcurrentRuns`, `hermesProfile` | An agent is not a subject in any permission model. `mcpConfig` is a **dead field** (§9) |
| Plugin layer (ours) | `collections/Plugins.ts`, `lib/plugins/resolve.ts` | R4, and genuinely good. Workspace rows; `scope: 'agents'` with an empty list by default so a new plugin reaches nobody; `{{RUN_TOKEN}}`/`{{RUN_ID}}`/`{{TEAM_SLOT_ID}}` substituted at resolve time so **no live credential is stored in a row**; a row referencing a placeholder with no value is **out of scope**, not blanked (`SLOT_SCOPED_PLACEHOLDERS`, `resolve.ts:83`); a row that cannot become a server is reported, not dropped. Wired live at `worker.ts:810` → `mcpServers` at `worker.ts:1063`, and re-used with no substitutions to render the agent page's Tools panel | Credentials that are *not* per-run live in `plugins.headers` as plaintext JSON — workspace-wide, one value for everybody. There is **no per-user credential concept anywhere in this codebase** |
| Runtime MCP + skills (theirs) | `settings/mcp`, `settings/skills`, `lib/runtimes/hermes/serve-client.ts` | A mirror of **one Hermes profile**, read and toggled over `hermes serve`'s HTTP API (`/api/skills*`, `/api/mcp/servers*`) with no mirror table — deliberately, per R4.3. `readConfigSubset` projects a subset because the raw `/api/config` response contains secrets. The only direct `config.yaml` write in the repo is the `model:` block, in `lib/runtimes/hermes/providers.ts:266`, with a timestamped backup | Hermes-only; a Claude Code workspace has no equivalent screen. Not per-agent. Toggle and test only — no add or remove |
| Our MCP surface | `app/api/mcp/route.ts`, `/artifacts`, `/teams`, plus `/api/daemon/page-writes` | Bearer `run_token` + `X-Run-Id`, compared against **that run's own** token, refusing a settled run with 409 (`route.ts:164/167`, `artifacts:388`, `teams:348`, `page-writes:41`). One rule, four endpoints, no drift. `/api/mcp/artifacts` additionally resolves and re-checks the run's workspace per tool. `/api/mcp/teams` binds the caller to its own slot | The token proves **"this run is live"**, not "the accountable user may do this" — after the check the handlers act with `overrideAccess: true`. **`get_page` in `app/api/mcp/route.ts:66` has no workspace filter at all**: any valid run token can read any page in any workspace by guessing a numeric id. Only `/api/mcp/teams` is auto-registered as a plugin row (`ensureTeamMcpPlugin`, `lib/teams/registration.ts:81`); the other two need a hand-made row |
| Approvals / human-in-the-loop | `lib/hermes/approval-helpers.ts`, `worker.ts:563`, `app/api/approvals/route.ts`, `components/thread/PermissionCard.tsx`, `components/teams/approval-strip.tsx` | A complete, working blocking mechanism: the ACP `session/request_permission` callback writes an `approvals` row, announces in the channel, sends a web push, and awaits. Identity comes **from the session, never a header** (the route says why). Timeouts settle in the database, and a human's answer wins the race against the timer | The waiter is a **module-level in-process `Map`** (`approval-helpers.ts:6`). It resolves only because the dispatcher runs inside the Next process (`workerId = server-${process.pid}`). **Two app instances break approvals silently.** The timeout is a fixed 5 minutes |
| Run accountability | `lib/broker/migrations/0001_...sql:34-38`, `lib/broker/runs.ts` | Every run carries `originator_user` and `accountable_user` (a real FK), the latter defined by its own migration comment as "whose budget and audit trail". `run_token` is minted at claim and **nulled at settle** with `mcp_overlay` (`runs.ts:222`) | `accountable_user` is read as an authorisation check in **exactly one place** in the whole repo: `inbox/actions.ts:61`. No run carries a capability set |
| Audit | `collections/Activity.ts`, `audit/page.tsx`, `lib/activity.ts` | A polymorphic `entityType`/`entityId`/`actor`/`action`/`payload` table with a workspace-scoped viewer, filters and pagination | Written from **two places only** — run review actions and task actions. `actor` is a user or null: **an agent cannot be an actor**. No `workspace` column, so the page reconstructs scope by listing every task/project/page id, capped at 5000 (its own comment). No `access` block: the audit log is rewritable over the open Payload API |
| Spend | `collections/Workspaces.ts:spendCapCents` | The column exists | "Not yet enforced by the dispatcher", per its own field description. And `updateSpendCap` is an unauthenticated server action |
| Connectors | — | Nothing. No connector concept, no Composio dependency in `package.json`, no third-party OAuth, no per-user credential store | Everything |

---

## 2. The gaps, named

Each of these blocks something a paying team does in its first week. I have
tried to say what *breaks*, not what would be nice.

**G0. The app is not currently safe to put on a public host, and this outranks
every feature below.** Twenty-two of twenty-three Payload collections are open
for unauthenticated CRUD over `app/(payload)/api/[...slug]`, including `Users`,
`Plugins` (which by its own design holds third-party API tokens in `headers`),
and `Activity` (the audit log). Sixteen `/api/hermes/**` routes are
unauthenticated, three of which write files or execute jobs on the host.
`POST /api/dispatcher/tick` is unauthenticated. `/api/search` returns whole
pages across every workspace. `saveAgent` writes arbitrary client-supplied keys
onto any agent with no session check. This is not a maturity gap that scales
with customer count — it is the same severity with one customer as with a
thousand, and nothing else in this document is meaningfully testable until it
is closed. It is Phase 0 for that reason and no other.

**G1. There is no organisation, so there is nobody to bill and nobody to
invite.** There is no entity above a workspace that owns a subscription, a
Composio key, a domain, or a list of people who have not joined a workspace
yet. The first customer conversation that goes "we want Engineering and
Marketing separately but on one invoice" has no answer.

**G2. There is no way to invite anyone.** One `invit` hit in the repository, in
an unrelated comment. A colleague joins today by someone signing them up and
then editing `workspaces.members` through the admin panel or the database.
There is also **no email transport in the repo at all**, so the mechanism an
invite would ride on does not exist either. This is the most-requested item on
the owner's list and also the cheapest.

**G3. Membership is binary, so there is no read-only colleague.** A workspace
member can change every agent's permission mode, delete projects, read plugin
credentials over the open API, and drive runs that spend money. A team of five
wants a viewer role on day one; a team of fifty will not sign without one.

**G4. Projects have no sharing model.** Project visibility equals workspace
membership. Giving a contractor one project means giving them the workspace,
including its agents and their credentials.

**G5. Channels can be private but nobody can be invited into one**, and a plain
member can perform leader-slot mutations because no guard reads the leader
role.

**G6. An agent is not a subject in any permission model, so "an agent may not
exceed its user" is true today only by accident.** The MCP endpoints authorise
on the run token and then act with `overrideAccess: true`. Nothing compares
what the agent is doing to what `run.accountable_user` may do. Today the blast
radius is bounded *structurally* — `lib/agent-page-writes.ts` can only append
under a subtree the run owns — but that bound is already leaky
(`get_page` at `app/api/mcp/route.ts:66` reads any page in any workspace), and
it disappears entirely the moment an agent can act on a connector. **This is
the gap that makes connectors dangerous rather than merely unbuilt.**

**G7. Approvals only work in a single process.** The waiter is an in-memory
`Map`, correct today because there is exactly one Node process. It makes
horizontal scaling impossible without an outage, and it is a hard prerequisite
for connect-from-chat, where the thing that settles the wait is an OAuth
redirect that can land on any instance.

**G8. There is no per-user credential anywhere, so a shared workspace cannot
have two people's Gmail.** `plugins.headers` is one value for the whole
workspace. That is the right design for a workspace-owned API token and the
wrong one for a personal OAuth grant, and today they are the same column.
Every connector story fails on this one fact.

**G9. `agents.mcpConfig` is a decoy.** Edited in the UI as a raw JSON textarea
(`agent-settings-form.tsx:358`), persisted, and **read by nothing** — zero
consumers in `lib/dispatcher/**`, `lib/runtimes/**` or `lib/hermes/**`.
Someone will configure MCP there, get no tools, and conclude the product is
broken.

**G10. The audit log records almost nothing, cannot name an agent, and is
rewritable.** Two call sites write to it; `actor` is a user or null; there is
no workspace column; there is no access block. In an incident — "who gave that
agent access to our Salesforce" — it answers nothing, and it could have been
edited by the person being investigated.

**G11. Nothing enforces spend.** `spendCapCents` is unread by the dispatcher by
its own admission, and its setter is unauthenticated. With connectors this
stops being a budgeting nicety: Composio meters tool calls and overage is real
money (§6).

---

## 3. The identity and tenancy decision

### The correction that changes the shape of this work

The owner's note says "using betterauth if possible". **Better Auth is already
the auth library.** `lib/auth.ts` runs `betterAuth()` with its own pool;
`package.json` pins `better-auth: ^1.4.22` and `@better-auth/cli`. So this is
not a migration. It is enabling a plugin on an install that already exists, and
that is a materially smaller and less risky piece of work than the phrasing
implies. The risk in this section is not Better Auth. It is the two id spaces.

### The two id spaces, and what I would not do about them

Better Auth owns `user`/`session`/`account`/`verification` with **text** ids.
Payload's `users` has **integer** ids. `lib/current-user.ts` joins them by
creating a shadow Payload row keyed on email the first time a session is seen.
Every relationship in the product points at the Payload integer:
`workspaces.owner`, `workspaces.members`, `activity.actor`,
`approvals.requestedUser`, `team_members.user_id`, and — in raw Postgres with a
real foreign key — `runs.accountable_user`.

**I would not re-key any of that.** Moving the app onto Better Auth's text ids
means rewriting relationships across six Payload collections, a real FK on the
broker's `runs` table, `payload-types.ts`, and every comparison of the shape
`approval.requestedUser !== user.id` — a comparison that has *already* produced
one live bug here (the depth-0 fix documented in `approval-helpers.ts`'s
`getApprovalByExternalId`, where a populated relationship object compared to a
numeric id made every Approve click answer "You do not have access"). It is
weeks of work, it touches the audit trail and the run ledger, and it buys
nothing that a join column does not.

**Recommendation: add `users.betterAuthId` (text, unique, indexed) and make
that the join, replacing email equality.** `lib/current-user.ts` looks up by
`betterAuthId`, falls back to email once, and backfills. Better Auth becomes
the authority on *who someone is*; Payload stays the authority on *what they
are attached to*. One column, one function changed, and the email-change
desynchronisation disappears as a side effect.

If you ever find yourself writing a script that renumbers users, stop — you
have taken the wrong branch.

### Organisation above workspace, not instead of it

**Recommendation: an organisation is a new layer above workspace.**

The alternative — workspace *becomes* the org — is genuinely cheaper and
deserves a fair statement rather than a dismissal. It needs no new table, no
new URL segment, and no backfill beyond a name; Better Auth's `organization`
maps onto `workspaces` almost field for field. If this product will only ever
be sold to teams that want exactly one workspace, that is the right answer and
it saves a year of carrying a layer nobody uses.

I recommend against it for three reasons, all properties of code that already
exists:

1. `workspaces.slug` is globally unique and appears in every URL
   (`/workspace/[workspaceSlug]`). Making the workspace the billing entity
   means one subscription per URL segment. The first customer who wants two
   workspaces on one invoice forces the layer to be introduced anyway — but
   then with live data in it.
2. `runtime-profiles`, `runtimes`, `agents` and `plugins` are all
   workspace-scoped today. A *runtime* is naturally an organisation-level
   asset: one Hermes install, one Claude Code installation, shared across a
   company's workspaces. With workspace-as-org every workspace re-declares its
   runtimes, and R12-P4's promise — "changing the default model on the Claude
   Code runtime changes every agent that has not overridden it" — stops at the
   workspace boundary for no good reason.
3. A Composio API key is billed per Composio organisation and **rate-limited
   per Composio organisation** (§6). Putting it on a workspace means either
   duplicating a key or inventing an implicit sharing rule.

So: **organisation** = the billing and identity boundary, the thing you invite
people *to*, the thing that holds a Composio key and a runtime fleet.
**Workspace** = exactly what it is today, a project space, now belonging to an
org.

### Better Auth's organisation plugin — what it gives, what it does not

Checked against `better-auth.com/docs/plugins/organization` on **2026-09-04**,
against installed version `^1.4.22`. Treat the specific option names as things
to confirm against the version you actually install; the shape is what matters.

**For free:**

- `organization`, `member`, `invitation` tables, and `activeOrganizationId` on
  the session (plus `activeTeamId` if teams are enabled).
- A real invitation flow: `inviteMember()` → link → `acceptInvitation(id)`,
  with `invitationExpiresIn` (default 48h), `invitationLimit` (default 100),
  `cancelPendingInvitationsOnReInvite`, and
  `requireEmailVerificationOnInvitation`.
- Three built-in roles — `owner`, `admin`, `member` — with `creatorRole`
  configurable.
- An access-control primitive: `createAccessControl(statement)` and
  `ac.newRole()` over resources with actions, plus optional
  `dynamicAccessControl: { enabled: true }` for per-org custom roles at
  runtime (backed by an `organizationRole` table, capped by
  `maximumRolesPerOrganization`).
- A complete set of `before*`/`after*` hooks across organisation, member and
  invitation lifecycle — which is exactly where §10's audit writes hang.
- Limits worth knowing: `membershipLimit` (default 100),
  `allowUserToCreateOrganization`, `organizationLimit`.

**Not for free, and this is the part that decides §4:**

- `sendInvitationEmail` is a callback *you* implement. **There is no email
  transport in this repository.** Choosing one is a blocking task in Phase 1,
  not a detail.
- Its access control answers questions about *its own* resources — may this
  member invite, update the org, cancel an invitation. It models nothing about
  projects, channels, pages, agents, connectors or runs. **Object-level ACL is
  ours to build and always was.**
- It knows nothing about agents. There is no non-human subject.
- Nothing about billing, seats or usage.
- No organisation-scoped API keys and no per-organisation database (I looked;
  the docs mention neither — **VERIFY** if you were counting on either).

**On Better Auth's `teams` sub-feature: do not enable it.** This repository
already has a `teams` table, and `lib/broker/migrations/0013_channels.sql`
states in its header that `teams` **are** channels, deliberately not renamed
because "a rename buys nothing and costs every query, every type and every
comment in the repository". Turning on Better Auth's teams puts a second,
unrelated `team` table in the same database. Two things called a team in one
schema is the ambiguity that produces a wrong join at 2am. Use workspaces as
the sub-organisation grouping — which is what they already are — and keep one
meaning for the word. (Better Auth's teams are documented as stable; this is a
naming decision, not a quality judgement.)

### What the migration actually costs

Smaller than it sounds, because the install is young:

- One Better Auth CLI migration creating `organization`/`member`/`invitation`
  and extending `session`.
- One Payload migration: `users.betterAuthId`, `workspaces.organization`.
- A backfill: one organisation per distinct current workspace owner; each
  existing workspace attached to its owner's org; each `workspaces.members`
  entry written as an org `member`, the owner as `owner`.
- `lib/current-user.ts` changes shape (join by id, backfill on miss).
- The workspace layout's owner-or-member check becomes an org-plus-workspace
  check inside Phase 0's shared authz module.

No existing row's id changes. That is what makes it cheap.

---

## 4. The permission model

### Subjects

Three, and the third is the one people forget.

- **User** — a Better Auth identity joined to a Payload `users` row.
- **Agent** — `collections/Agents.ts`. An agent is *never* an independent
  authority. It always acts on behalf of a user, and the run row already
  records which one: `runs.accountable_user`, a real FK whose own migration
  comment defines it as "whose budget and audit trail".
- **Service** — the dispatcher, the runtime host, the MCP endpoints, a webhook
  from Composio. These act with system authority and must be authenticated as
  such. Today `POST /api/dispatcher/tick` has none, and there is no shared
  secret anywhere in the repo to check against.

### Objects and verbs

| Object | Verbs |
|---|---|
| organisation | `read`, `admin` (settings, billing, keys), `invite`, `grant` (roles) |
| workspace | `read`, `write`, `admin` (settings, members, spend cap) |
| project | `read`, `write`, `admin` (resources, ACL), `run` (dispatch an agent against it) |
| channel | `read`, `post`, `admin` (roster, archive) |
| page / database | `read`, `write`, `comment` |
| agent | `read`, `use` (dispatch a run), `configure` (instructions, skills, tools, permission mode) |
| connector / plugin | `read`, `use` (an agent may call its tools), `connect` (bind *my* account), `admin` (create the row, set scope, hold the key) |
| run | `read`, `cancel`, `approve` |
| runtime | `read`, `configure` |

Deliberately *not* a per-field capability matrix. D2's reasoning about runtime
capabilities applies here too — a matrix we maintain rots. Nine objects and
about four verbs each is a table a person can hold in their head; anything
finer should be an ACL row on the object, not a new verb.

### Roles are a default; the grant is what is checked

Three org roles (`owner`, `admin`, `member`) from Better Auth, three workspace
roles we define (`admin`, `member`, `viewer`), and a project ACL for the
exceptions. This split matters because G4's contractor is exactly the case a
pure role model cannot express: `read` + `write` on one project and nothing
else in the workspace.

### Where enforcement lives — three layers, all required

1. **`lib/authz/` — one module, the only place a decision is made.** The
   precedent already exists and is good:
   `app/(app)/workspace/[workspaceSlug]/teams/actions.ts` encodes two
   instincts that are easy to miss. First, an id off the wire is hostile even
   when the layout already checked it — "a server action is reachable without
   ever rendering that layout", in its own words. Second, a refusal on a
   private object returns `not_found`, not `forbidden`, so probing ids cannot
   confirm existence. Generalise those helpers into `lib/authz/` and route
   **every** server action through them. This is mechanical work and it is the
   bulk of Phase 0.
2. **Payload `access` blocks on every collection.** Not because the app uses
   them — everything goes through `overrideAccess: true` — but because
   `app/(payload)/api/[...slug]` is a public endpoint and today it is open on
   twenty-two of twenty-three. These blocks are the floor under layer 1, not a
   substitute for it.
3. **The machine endpoints.** The four run-token endpoints need the capability
   check below; `/api/dispatcher/tick` and `/api/hermes/**` need a service
   credential.

### The rule that matters: an agent may never exceed its user

This is the load-bearing sentence of the document, and it is hard precisely
because runs are asynchronous — the user is not there when the tool call
happens.

**What the app already gets right.** `claimNextRun` mints `run_token` at claim;
the four machine endpoints compare the presented token against *that run's own*
and refuse a settled run; `settleRun` nulls `run_token` and `mcp_overlay` in
the same statement (`runs.ts:222`) so no live bearer credential survives in a
settled row; `lib/plugins/resolve.ts` never stores a live credential in a row
at all. That is a sound foundation. What it proves is *"this run is live"* — it
does not prove *"the person this run is for is allowed to do this"*.

**What the app already gets wrong, as evidence that the gap is real.**
`get_page` in `app/api/mcp/route.ts:66` does `payload.findByID` with
`overrideAccess: true` and **no workspace filter**. Any valid run token reads
any page in any workspace by guessing a numeric id. Its sibling
`/api/mcp/artifacts` does resolve and re-check the workspace per tool
(`resolveRunWorkspace`, then `artifact.workspaceId !== workspaceId`), which is
the correct shape and shows the fix is understood — it simply was not applied
to the older endpoint.

**The proposal: a capability snapshot, minted with the token and dead with
it.**

At claim time the dispatcher computes

```
effective = permissions(run.accountable_user) ∩ grants(run.agent_id)
```

and writes it onto the run row as a `capabilities` JSONB column, nulled by
`settleRun` in the same statement that already nulls `run_token`. Every
machine endpoint, and every connector tool call, checks the capability set
rather than only the token. The **intersection** is the rule: an agent
configured with broad grants but dispatched by a viewer gets the viewer's
authority.

**Why a snapshot and not a live lookup.** The alternative is to re-resolve
permissions on every tool call. That adds a query to the hot path, which D0
forbids without a stated cost, and — worse — it makes a permission revoked
mid-turn produce a half-completed action: three files written, the fourth
refused, and an agent narrating a partial failure at the user. A snapshot gives
a bounded, stateable window: **a revocation takes effect on the next run, and
no run outlives its lease** (60s default, renewed every 15s;
`LEASE_RENEW_INTERVAL_MS` in `worker.ts`). That is a sentence you can put in a
security questionnaire. "Eventually, mostly" is not.

**Where a revocation must be immediate, the mechanism already exists.**
`cancel_requested_at` on the run row is honoured by the dispatcher
(`requestRunCancel`, migration `0010_run_cancel_request.sql`). Removing a
person from an organisation should cancel their in-flight runs, not merely stop
new ones. That is one query, and it belongs in Better Auth's
`afterRemoveMember` hook.

**For connectors the rule has a precise mechanical form, and the codebase
already contains the pattern.** A connector's credential belongs to a *person*,
so the Composio user id must resolve from `run.accountable_user` and never from
the agent row. `lib/plugins/resolve.ts` already implements exactly this shape
for team slots: a placeholder listed in `SLOT_SCOPED_PLACEHOLDERS` that has no
value makes the row **out of scope for this run** — no server injected, and no
`skipped` entry either, because it is not a fault. Add `COMPOSIO_USER_ID` to
that list and the behaviour falls out for free: *an agent whose accountable
user has not connected Gmail simply does not receive the Gmail server.* Not a
tool that fails; not a blank header that looks supplied; absent. That is the
same reasoning `collections/Plugins.ts` already gives for why a disabled plugin
is absent rather than present-and-refusing, applied one level down.

---

## 5. Connectors vs MCP — the decision, argued

### They are not the same thing, and conflating them is the expensive mistake

A **connector** is an *authorisation*: a grant by a specific person letting
something act as them on a third-party system. It has an owner, a scope set, an
expiry, a refresh, and a revocation. A **MCP server** is a *transport*: an
endpoint that answers `tools/list` and `tools/call`. One is a fact about a
person; the other is a fact about a network address.

The evidence that they get conflated is already in this repository, and it is
not a criticism — it is the correct design for what it was built for.
`collections/Plugins.ts` is a transport row that has grown a credential store:
`headers` is "where an API token for a third-party tool lives", by its own
comment. That works perfectly for a workspace-owned key. It breaks completely
the moment two people in one workspace need different Gmail accounts, because a
plugin row has exactly one `headers` value and no notion of *whose*.

**Composio is both**, which is why the distinction blurs. It is a connection
broker (auth configs, connected accounts, token refresh) *and* an MCP surface
(hosted per-user MCP URLs). Buying one does not mean buying the other, and
deciding which half you are buying is the actual decision here.

### The three candidate owners, and the cost of each answer

D4 already ruled on two of them: *runtime level is a mirror; plugin level is
state*, and it names Composio at the plugin level for precisely the reason
argued above — "it needs per-user connected accounts and permission scoping
that a CLI config file cannot express". What follows extends that with a rule
in R11's spirit, because R11's real contribution was not the GitHub design but
the sentence "every field has exactly one owner, so there is nothing to
reconcile".

**If Composio owns all MCP.** You cannot run a tool that has no Composio
toolkit — which includes your own `/api/mcp`, `/api/mcp/artifacts` and
`/api/mcp/teams`, and every customer's internal server. You inherit their rate
limit as your product's ceiling: **per Composio organisation, over a fixed
one-minute window, shared across every authenticated endpoint** — 2,000
requests/min on Hobby, 10,000 on Pro (docs.composio.dev/reference/rate-limits,
checked 2026-09-04). And their pricing becomes your cost of goods with no
lever: tool-call overage moved from roughly $0.25–0.30 per 1,000 calls to $4
per 1,000 for signups on or after 2026-08-15, with triggers, LLM tokens,
premium tools, sandbox compute and storage newly metered separately
(secondary source, **VERIFY against your own Composio account and contract**).

**If the runtime owns all MCP.** No per-agent scoping at all — a server written
into `config.yaml` is available to every agent that runtime ever runs, forever,
with no way to revoke it for one agent but not another. And no per-user
credentials, because a config file has no concept of a user.
`collections/Plugins.ts`'s own header makes this argument already; there is
nothing to add.

**If we own all MCP.** We are writing an OAuth broker for three hundred
applications, with token refresh, revocation, provider-specific quirks and a
security surface that is entirely liability. That is Composio's whole business
and it is not ours.

### The rule

> **A tool server has exactly one owner, and the owner is decided by who owns
> its credential.**
>
> - The credential belongs to **the machine** → the **runtime** owns it.
>   Hermes's `config.yaml`, Claude Code's own MCP config. We mirror and toggle;
>   we write no ownership into it (R4.3).
> - The credential belongs to **the workspace** → **we** own it. A `plugins`
>   row with `headers`, and `{{RUN_TOKEN}}` for anything per-run.
> - The credential belongs to **a person** → **Composio** owns it, and we own
>   only the pointer: `user_id`, `auth_config_id`, `connected_account_id`. **We
>   never store a third-party access token.**

That rule is decidable at the point of configuration — "whose password is
this?" — which is what makes it usable, and it means no field is owned twice,
which is what makes it R11's rule rather than a restatement of D4.

### Recommendation: all three, and connectors are two tables, not one

A connector is **not** a fourth concept parallel to plugins. R4.2 and R4.4
already made "an HTTP MCP endpoint is a plugin row" true, and R4.4's whole
point was that Composio needs *a row, not code*. A second server table would
need its own scoping, its own resolve pass, its own audit, and its own bugs.

But a plugin row genuinely cannot hold per-person state. So split it exactly
where the ownership rule splits it:

- **The server definition stays a `plugins` row**, gaining `provider`
  (`'composio' | null`), `toolkit` (a slug like `gmail`), and `authConfigId`.
  Its `url` is the Composio MCP endpoint; its headers carry
  `{{COMPOSIO_USER_ID}}`, substituted per run from `run.accountable_user`. It
  inherits scope, enable/disable, per-agent targeting, `_meta` config options
  and the injection path for free.
- **The grant becomes a new, small `connections` table**: `(id, organisation,
  user, provider, toolkit, auth_config_id, connected_account_id, status,
  created_at, revoked_at)`. **No credential in it** — only Composio's opaque
  ids. One row per (person, app).

Two tables, each with one job. The resolve step already knows how to make a
row out-of-scope when a per-run value is missing, which is precisely the
behaviour needed when the accountable user has no connection.

There is even a precedent for auto-provisioning the plugin row rather than
making a person hand-write one: `ensureTeamMcpPlugin`
(`lib/teams/registration.ts:81`) already creates a `plugins` row with the
right auth headers when a team is set up. Enabling a toolkit for a workspace
should do the same thing.

---

## 6. Composio integration plan

Everything in this section marked **VERIFY** should be confirmed against your
own Composio account before it is built on. All dates are when I checked.

### Vocabulary, mapped onto ours

| Composio | What it is | Our side |
|---|---|---|
| **Toolkit** | An application (Gmail, Linear, GitHub) and the tools it exposes | `plugins.toolkit`, a slug |
| **Auth config** | How to authenticate to that toolkit — either Composio-managed OAuth (their OAuth app) or custom/BYO where you supply your own OAuth client credentials | `plugins.authConfigId`, held at organisation level |
| **Connected account** | One user's completed grant against one auth config, with a `status`; Composio handles token refresh | `connections.connected_account_id` |
| **`user_id`** (entity id) | The identifier representing a user *in your system*, passed when initiating a connection and when executing tools | Our Payload user id, as a **prefixed string** |

**Map `user_id` to `nf_user_<payload id>`, never to an email.** Emails change,
and a bare integer collides the moment a dev and a prod deployment share a
Composio account. This is a one-line decision that is very annoying to reverse
once there are live connected accounts.

### Bring-your-own key first; our key in SaaS later

**Recommendation: build BYO-key first.** Three reasons, in order of weight.

1. It is testable today with no billing relationship, no metering and no cost
   attribution machinery. Our-key requires all three before it can safely be
   turned on for a second customer.
2. Rate limits are **per Composio organisation** over a one-minute window, with
   every authenticated endpoint drawing from one budget (checked 2026-09-04).
   With our key in SaaS that is one shared bucket for every tenant: a single
   customer's agent loop can 429 everybody else. Solving that needs per-
   workspace token buckets *of our own on top of* Composio's — not instead of
   them — and that is work you do not want on the critical path to the first
   connector shipping.
3. Self-managed credentials — a customer keeping custody of their own OAuth
   apps rather than using Composio-managed ones — reportedly sits behind a
   $599/mo tier under the 2026 pricing (secondary source, **VERIFY**). If that
   is right, BYO key is not merely the cheaper first step, it is the only way a
   security-conscious customer keeps their own OAuth clients without you buying
   that tier on their behalf.

**Key storage is a prerequisite, not a detail.** The org's Composio API key
must be encrypted at rest and never rendered back to a browser — the same rule
`collections/Plugins.ts` already states for header values. **There is no
encryption-at-rest helper in this repository today.** Writing one (or adopting
a KMS) is a real task in Phase 4 and it gates everything after it. Storing this
key the way `plugins.headers` currently stores tokens — plaintext JSON in an
openly-readable collection — would be worse than not shipping connectors.

### The auth flow, and the deprecation that decides it

Composio's docs (checked 2026-09-04) state that `initiate()` **stops working
for Composio-managed OAuth auth configs from 2026-05-08 for new organisations
and 2026-07-03 for all organisations**, and that `link()` — hosted
authentication — is unaffected. Today is after both dates.

**Use `link()`.** Do not build on `initiate()` even in a prototype; it remains
functional only for custom auth configs and non-OAuth schemes (API key, bearer,
basic), which is a narrower path than you want the primary flow to sit on.
**VERIFY** the exact method names and signatures against the SDK version you
install — the docs I read describe both a Python and a TypeScript surface and I
did not read the TypeScript reference directly.

The flow:

1. Call `link()` for `(user_id, auth_config_id)`. It returns a redirect URL.
2. The person visits it and completes the third-party consent.
3. Completion is observed either by polling (`wait_for_connection()`) or by
   webhook. The docs mention webhooks but the page I read did not detail them —
   **VERIFY whether a connection-completed webhook exists and what it signs
   with.** This matters a lot for §7 and the answer changes the design.
4. Status is read with `connected_accounts.get(connected_account_id)` and its
   `status` field.

Note that both methods refuse a duplicate active connection unless
`allowMultiple: true` — relevant if you ever want one person to hold two Gmail
accounts, which they will want.

### Rate limits and cost attribution

Rate limit headers on every response: `X-RateLimit`, `X-RateLimit-Remaining`,
`X-RateLimit-Window-Size`, and `Retry-After` on a 429. Honour `Retry-After`;
do not retry immediately. Surface a 429 into the transcript as a named failure
(R12-P1's typed `AppFailure` vocabulary is the right home) rather than as a
generic tool error — "the connector is rate limited, retrying in 12s" is
actionable and "tool call failed" is not.

Cost attribution needs a place to land. `run_usage` already exists for provider
tokens; extend it, or add a `connector_calls` table keyed by (run, workspace,
toolkit). **Without this you cannot price the SaaS version**, and adding it
after the fact means the first months of usage data do not exist.

### What happens when a key is removed

Four distinct things, and they should not be conflated:

- **Future runs**: every `plugins` row whose `provider` is `composio` becomes
  out of scope immediately. The mechanism already exists — a missing
  substitution value makes a row out of scope with no server and no `skipped`
  noise.
- **In-flight runs**: they finish. Their next Composio tool call fails with
  Composio's own error, which must reach the transcript rather than a log.
- **`connections` rows**: set `status: 'orphaned'`, do **not** delete. Deleting
  loses the audit trail of who had connected what, which is precisely the
  record an incident needs.
- **The key itself**: overwritten, and an audit row written naming the actor.

### Failure modes worth designing for now

- **429** — bounded, header-driven backoff; never a bare retry loop.
- **A revoked grant** — the person revoked access at Google. Composio handles
  refresh, but a revocation surfaces as a tool error mid-turn. It must produce
  a "reconnect" affordance in the transcript, not a stack trace.
- **A toolkit renaming its tools between runs** — the agent will have narrated
  the old name. Nothing to do but fail clearly.
- **Composio down** — the plugin resolve step must not fail the run.
  `resolvePluginsForRun` already reports skipped rows rather than throwing, and
  `worker.ts:829` degrades to `{ servers: [], skipped: [] }` on failure.
  Preserve both.
- **Two people, one workspace, the same toolkit** — this is the normal case,
  not an edge case, and it is the whole reason `connections` is per-user.

---

## 7. Connect-from-chat

The owner's ask: an agent, mid-conversation, can offer a "connect this app"
component; clicking it opens the auth URL; the run waits for the callback and
then continues.

**Most of this already exists**, and saying exactly how much is the point of
this section.

### What can be reused, unchanged

The blocking machinery is complete and correct:

- The run genuinely blocks. `buildPermissionCallback` (`worker.ts:563`) is
  wired as the ACP `permissionCallback`, and the turn awaits it.
- `createPendingApproval` writes a durable `approvals` row.
- `announceApprovalInChannel` posts into the channel **before** waiting, so a
  person sees it while the run is still blocked.
- `sendPushToUser` fires a web push, fire-and-forget, so a push failure cannot
  fail the wait.
- `waitForApproval` races the waiter against a timeout, and a timeout settles
  in the **database** as well as in memory — with the update scoped to rows
  still `pending`, so a human answer landing in the same instant wins.
- `/api/approvals` takes identity from the session, never a header, and checks
  `approval.requestedUser !== user.id` before resolving.
- The transcript renders a live card from a `permission` RunEvent, emitted
  twice with the same id (once open, once settled) so a settled decision never
  leaves live buttons on screen.

That is five of the seven hard parts of an in-chat blocking interaction, built
and debugged. Reuse all of it.

### What genuinely has to be new

**1. The tool.** An agent cannot ask for a connection through
`session/request_permission` — that call means "may I do this thing I already
have the ability to do", and the ACP option kinds (`allow_once`,
`allow_always`, `reject_once`, `reject_always`) do not express "go and
authenticate". Connecting needs a real tool on **our** MCP surface: a
`connect_app(toolkit)` tool on a new `/api/mcp/connectors` route, authorised by
run token exactly like its three siblings, resolving `run.accountable_user`,
calling Composio `link()` with that user's `user_id`, and returning a pending
id. Reuse the existing auth block verbatim — it is four lines and it is already
right.

**2. Its own timeout.** Five minutes
(`buildPermissionCallback(run, run.accountableUser, 5 * 60 * 1000)`) is the
right budget for "may I run `rm`" and the wrong one for "go to Google, sign in,
pick an account, read a consent screen, come back". Give the connect wait its
own budget — 15 minutes is a defensible starting number — and a distinct
timeout message. **Do not raise the existing permission timeout**; that would
make every ordinary approval hang three times longer for no reason.

**3. The resolver is not a click.** `/api/approvals` settles because a human
presses a button in a page we rendered. A connect settles because a *third
party* redirects a browser back to us. So there must be a callback route,
`/api/connectors/callback`, which: never trusts the querystring, verifies the
connection with Composio (`connected_accounts.get(...)`, checking `status`),
writes the `connections` row, and only then calls into the same
`resolveApproval` path. It must be idempotent — a person will refresh it.

**4. The in-process waiter is the real blocker, and it is not Composio's
fault.** `pendingApprovalWaiters` is a module-level `Map`
(`lib/hermes/approval-helpers.ts:6`). It resolves today only because the
dispatcher runs inside the Next server process — `workerId =
server-${process.pid}` in `app/api/dispatcher/tick/route.ts`. An OAuth callback
can land on any instance the moment there are two. This is a pre-existing
single-process assumption that connect-from-chat is simply the first feature to
make obviously fatal.

The fix is small and it is worth doing on its own merits: the resolver writes
the decision to the database and NOTIFYs on the broker's existing
LISTEN/NOTIFY channel (`lib/broker/live-bus.ts`, `lib/broker/notify.ts`); the
waiter subscribes rather than sitting in a `Map`. D0's "no polling where a push
already exists" points at exactly this mechanism. It fixes approvals for
multi-instance too, which you need for SaaS regardless.

**5. The UI component.** A `ConnectCard`, sibling to `PermissionCard`. It
cannot *be* `PermissionCard`, because the interaction is "leave, do something
elsewhere, come back" rather than "choose one of these options". It needs: the
app's name and icon, a Connect button that opens the auth URL in a new tab, and
a live state — waiting / connected / failed / timed out — driven by the same
run event stream that already carries `permission` events. Add a `connect`
variant to the `RunEvent` union in `lib/run-events.ts` rather than overloading
`permission`; the union is discriminated and adding a member is cheap, while a
`permission` event that sometimes means something else is a trap for whoever
reads the transcript code next.

**Scorecard:** roughly 70% reuse. The durable row, the block, the channel
announcement, the push, the timeout-settles-in-the-database discipline and the
authorisation-on-answer are all free. The tool, the callback, the second
timeout budget, the card, and — the real work — moving the waiter off an
in-process `Map` are new.

---

## 8. Scoping: project, agent, workspace, runtime

### The five places a tool can be attached

| Level | Whose credential | Where it lives |
|---|---|---|
| Runtime | the machine's | Hermes `config.yaml` / Claude's own MCP config; mirrored, never owned (R4.3) |
| Organisation | the company's | a `plugins` row inherited by every workspace in the org (new) |
| Workspace | the workspace's | a `plugins` row, `scope: 'workspace'` (exists today) |
| Agent | still the workspace's, but granted narrowly | a `plugins` row, `scope: 'agents'` (exists today) |
| Project | the project's | a `plugins` row with a `project` relationship (new) |

Orthogonal to all five: the **connection**, which is always a person's, and
which gates whether a connector row resolves for a given run at all.

### Precedence is the wrong word, and using it is the trap

`runtimeConfig` has a genuine precedence chain — runtime default → agent →
per-turn override — implemented at `worker.ts:1085-1093` and specified by
R12-P4.1. It is correct there because those are *scalars*: one model, one
effort level, and the most specific value wins.

**Tool servers are not scalars.** There is no sensible reading of "the
project's Gmail overrides the workspace's Gmail" — an agent either has the
Gmail tools in its session or it does not. Applying an override chain here
would silently *remove* capability that a workspace admin had granted, which is
the opposite of what a more specific scope should mean.

**The rule is union with two filters:**

> The servers a run receives = the union of every level in scope for it
> (runtime ∪ organisation ∪ workspace ∪ agent ∪ project-if-the-run-has-one),
> filtered by:
> (a) the run's accountable user has a live `connections` row for every
> connector in the set — otherwise that row is *out of scope*, not broken; and
> (b) the run's capability snapshot (§4) grants `use` on it.

Name collisions are real: two levels can both contribute a server called
`gmail`, and two identically-named servers in one `session/new` is a genuine
bug, not a cosmetic one — the agent narrates tool names at the user. Qualify
the injected name with its level (`gmail`, `gmail@project`) and say so in the
UI, rather than silently dropping one.

**State this explicitly in the code**, because the mistake someone will make in
six months is folding tool servers into the `sessionConfig` merge at
`worker.ts:1085` since it is right there and looks like the place for
"defaults".

### The UI on each surface

- **Project → Connectors tab.** Which apps this project's runs may use, plus
  which of the project's resources they touch. Rendered **conditionally** —
  R11.3's rule that a local-only project must not grow empty tabs applies
  equally here, and R7.4 already cut this page from eight tabs to four once.
- **Agent → Tools tab** (rename the current Capabilities tab). Three groups:
  *Runtime* (read-only mirror, shown only when the agent's runtime declares a
  home strategy that has one), *Workspace plugins* (a per-agent toggle writing
  `plugins.agents` from this side), and *Connectors* (per-app on/off, with the
  connection state resolved for the **viewing** user, not the agent — "you have
  not connected Gmail" is a true and useful sentence, "this agent has not
  connected Gmail" is neither).
- **Settings → Connectors.** The org's Composio key (write-only), the toolkit
  catalogue, auth configs, and every member's connection status — *existence
  and status, never a token, and never the third-party account's own details.*
- **Settings → Runtimes → a runtime.** R12-P4.2's screen, and the natural home
  for the Hermes `config.yaml` MCP and skills mirror that currently sits in two
  standalone rail entries. R12-P4.3's "group per runtime, not per vendor" is
  the same move.

---

## 9. The agent detail page

### What it actually does today

Five tabs (`agent-detail-view.tsx:240`): overview, capabilities, sessions,
memory, settings.

`agent-settings-form.tsx` edits, with these exact controls: `name` (text),
`runtimeProfile` (select), `hermesProfile` (select, shown only when the
runtime's `homeStrategy` is `hermes`), `model` (select), `runtimeConfig`
(controls generated from the runtime's own handshake — this is D2 working
properly), `thinkingLevel`, `instructions` (textarea), `customEnv` (JSON
textarea), `customArgs` (JSON textarea), `mcpConfig` (JSON textarea), `skills`
(JSON textarea, labelled "advanced edits only"), `maxConcurrentRuns`,
`permissionMode`, `enabled`.

`agent-capabilities.tsx` is the *real* skills editor: it lists Hermes's skill
library from `/api/hermes/skills` and binds/unbinds them per agent with an
optimistic write to `agent.skills` and a rollback on failure. It also lists
Hermes's MCP servers and their published tools — **read-only, no toggle**.

`agent-plugin-capabilities.tsx` renders a read-only Tools panel from
`resolvePluginsForRun` called with no substitutions, which is exactly what that
function's docstring says it is for.

So the honest position is: **the agent page is further along than "you cannot
configure skills and MCP" suggests.** Skills have a working picker. Plugins
have a working read-only view. What is missing is narrower and more specific
than the ask implies.

### What is wrong or missing

1. **`mcpConfig` is a dead field with a live editor.** Written by the form,
   read by nothing. Delete it — do not wire it. The plugin layer is the right
   home for per-agent MCP, and two mechanisms for one thing will drift, which
   is the argument `collections/Plugins.ts` already makes against mirroring the
   runtime's config. Deleting it needs a Payload migration and one form field
   removed.
2. **Two editors for one field.** `skills` is a picker in Capabilities and a
   raw JSON textarea in Settings. The textarea is labelled "advanced", which is
   the standard way this kind of thing survives for two years. Remove it.
3. **The capabilities tab is hardcoded to Hermes.** It calls `/api/hermes/*`
   unconditionally, so a Claude Code agent is shown a Hermes skill library.
   That violates D2 (derive from the declared handshake, and keep *unknown* as
   a third state) and R12-P4.3. The skill source has to come from the agent's
   runtime, with an honest "this runtime does not declare skills" state — which
   is a different sentence from "no skills".
4. **The Tools panel is read-only and links out.** Scoping an agent to a plugin
   today means going to Settings → Plugins and editing that plugin's `agents`
   list from the other side. The data to do it from here is already loaded.
5. **No inherited-value display.** R12-P4.4 asks for "model — inheriting
   `sonnet` from the Claude Code runtime" wherever a field is unset. The
   three-layer merge exists in the dispatcher; the agent editor does not show
   it. An invisible inherited default is the same bug as no default.
6. **`saveAgent` has no field whitelist and no authorisation** (§1). Any client
   key is written to any agent. This is Phase 0 work, but it lands on this
   screen.

### What to add, and how it interacts with runtime defaults

A **Tools tab** carrying the three groups from §8, with connectors resolved
per viewing user; skills sourced from the runtime's declared capability rather
than from Hermes by assumption; plugin scope toggles written from this side;
and inherited values shown wherever a field is unset.

**The interaction rule, stated once so it is not rediscovered:** the
`sessionConfig` merge (runtime default → agent → per-turn) is for *scalars* and
is correct as built. **Tool servers do not join that merge.** They union, per
§8. Putting connectors into `defaultSessionConfig` because it is the nearest
existing mechanism would make an agent-level connector silently delete a
workspace-level one.

---

## 10. Audit and observability

### What must produce a record, and none of it does today

Grouped by section, with the subject that performs it:

*Identity and tenancy (§3)* — organisation created; member invited, invitation
accepted, revoked, expired; member removed; role changed; workspace created,
renamed, deleted; workspace member added or removed. Better Auth's
`after*` hooks are the natural write point for all of these.

*Permissions (§4)* — a project ACL grant or revoke; an agent's
`permissionMode` changed; a capability snapshot computed for a run (recorded
once per run, not per tool call — D0).

*Connectors (§5, §6)* — Composio key set, rotated or removed; a toolkit enabled
or disabled for an organisation or workspace; a plugin row created, scoped,
enabled or disabled; **a connection created, refreshed, failed or revoked**;
a connector tool call refused because the accountable user had no connection.

*Runs (§7)* — approval requested, granted, denied, timed out; a connect
requested and completed; a run cancelled and by whom.

*Money (§11)* — spend cap changed; a run refused for exceeding it.

None of these is written today. `lib/activity.ts` is called from two files.

### What a record needs to be useful in an incident

The question an incident asks is "who gave that agent access to our Salesforce,
when, and what did it do with it". To answer it a row needs:

- **Subject** — and it must be able to be an *agent*, which `activity.actor`
  (a `users` relationship) cannot express today. Add `actorType:
  'user' | 'agent' | 'service'` plus `actorId` as text, in the same spirit as
  the existing `entityType`/`entityId` pair and for the same reason: runs live
  in raw Postgres, not a Payload collection.
- **On whose behalf** — for an agent action, `run.accountable_user` and the run
  id. Without this an agent action is unattributable to a human, which is the
  entire point of having an `accountable_user` column.
- **Object** — type, id, **and a human label captured at write time**. A
  project renamed next month must not rewrite last month's audit trail.
- **Provenance** — IP and session id for a human; run id and agent id for an
  agent; the calling service for a machine.
- **Before and after** where the change is a value. "Permission mode changed"
  is nearly useless; "permission mode: ask → auto" is the whole finding.

### Three structural changes to `Activity`

1. **Add `workspace` and `organisation` columns.** The audit page currently
   reconstructs workspace scope by listing every task, project and page id and
   filtering `entityId` against them, capped at 5000 by its own comment. That
   is three extra queries on every audit page load and it silently drops the
   overflow. Two indexed columns replace all of it. This is also a D0 win, not
   a cost.
2. **Add an `access` block.** The audit log is currently rewritable over the
   open Payload API. It should be create-only for everyone and read-scoped to
   the workspace, with no update or delete path at all. An audit log that the
   person under investigation could have edited is not evidence.
3. **Populate `run` as a real entity type.** `ACTIVITY_ENTITY_TYPES` already
   lists it and nothing writes it — the collection's own comment says "later
   run". That day is now: every item in the Connectors and Runs groups above is
   a run-scoped fact.

---

## 11. The order to build it in

Sizes are rough and assume one person who knows this codebase. Each phase says
why it sits where it does, because the ordering is the argument.

---

**Phase 0 — Close the open doors.** *~4–5 days.*

Payload `access` blocks on all 23 collections. A shared `lib/authz/` generalised
from `teams/actions.ts`'s helpers. Every `'use server'` file routed through it —
the third tier (no session check at all) first, then the second (session but no
workspace check). A service credential on `POST /api/dispatcher/tick` and the
sixteen `/api/hermes/**` routes. A session check plus workspace filter on
`/api/search`, `/api/agents`, `/api/runs/[id]`, `/api/user-databases/**` and
`/api/payload-datasource/**`. A field whitelist on `saveAgent`. A workspace
filter on `get_page` (`app/api/mcp/route.ts:66`), matching what
`/api/mcp/artifacts` already does.

*Why first:* everything below adds surface, and adding surface to an app whose
public API is open on twenty-two collections multiplies the problem rather than
adding to it. Also: none of Phases 1–9 can be honestly *tested* until an
unauthorised request actually fails.
*Unblocks:* everything. *Delivers:* an app that can be put on a public host.

---

**Phase 1 — Organisations, invitations, and email.** *~1 week.*

Enable Better Auth's `organization` plugin (**without** `teams`). Add
`users.betterAuthId` and switch `lib/current-user.ts` onto it. Add
`workspaces.organization` and backfill one org per current workspace owner.
Pick and wire an email transport — there is none today — and implement
`sendInvitationEmail`. Invite and accept UI, at both org and workspace level.
Cancel in-flight runs in the `afterRemoveMember` hook.

*Why here:* it depends only on Phase 0, and it is the single most-requested
item. *Unblocks:* every "invite" in the owner's list, and the org-level home
for a Composio key. *Delivers:* two people can share this product without a
database edit.

---

**Phase 2 — The permission model.** *~1.5 weeks.*

Workspace roles (`admin`/`member`/`viewer`). A project ACL. Channel membership
already exists in `team_members` — reuse it, add a leader guard. The
subject/object/verb checks in `lib/authz/`. The run capability snapshot: a
`capabilities` column minted with `run_token` and nulled by `settleRun`, plus
the check in all four machine endpoints.

*Why here:* the capability snapshot is what makes "an agent may never exceed its
user" true, and every scoping decision from Phase 4 onwards assumes it exists.
Building connectors first and retrofitting this means auditing every connector
call site twice. *Unblocks:* Phases 4–6. *Delivers:* read-only colleagues,
per-project sharing, and a defensible answer to the agent-authority question.

---

**Phase 3 — Approvals survive two processes.** *~3 days.*

Move `pendingApprovalWaiters` from an in-process `Map` onto the broker's
existing LISTEN/NOTIFY. No new dependency, no new poll (D0).

*Why here and not later:* it is a hard prerequisite for Phase 5, and it is
cheap **now** and expensive once connect-from-chat has been built on top of the
`Map`. It is also the only thing standing between this app and a second
instance. *Unblocks:* Phase 5, and horizontal scaling. *Delivers:* approvals
that work with more than one server process.

---

**Phase 4 — Connectors, BYO key, workspace level only.** *~2 weeks.*

Encryption at rest for the org's Composio API key (new; nothing in the repo
does this today). The `connections` table. `provider`/`toolkit`/`authConfigId`
on `plugins`. `COMPOSIO_USER_ID` added to `RunSubstitutions` **and** to
`SLOT_SCOPED_PLACEHOLDERS`, so a run whose accountable user has no connection
simply does not receive the server. A Settings → Connectors screen: paste a
key, browse toolkits, connect an app for yourself, see who else has connected
what. Auto-provision the plugin row the way `ensureTeamMcpPlugin` already does.

Deliberately **not** in this phase: chat, project level, our own key, metering.

*Why here:* it needs Phase 2's capability snapshot and Phase 1's org to hold
the key. *Unblocks:* Phases 5, 6 and 9. *Delivers:* an agent can use a person's
Gmail, scoped correctly, with no credential stored by us.

---

**Phase 5 — Connect from chat.** *~1 week.*

`/api/mcp/connectors` with a `connect_app` tool, authorised by run token.
`/api/connectors/callback`, idempotent and verifying with Composio rather than
trusting the querystring. A `connect` variant on `RunEvent`. A `ConnectCard`.
Its own 15-minute timeout budget, separate from the permission timeout.

*Why here:* it is the highest-visibility feature in this document and it
depends on Phase 3 (the waiter) and Phase 4 (the connection model). Built
before either, it is a demo that breaks the first time you run two servers.
*Delivers:* the thing the owner actually described — create an agent, create a
skill, connect an app, all without leaving the conversation.

---

**Phase 6 — Scoping surfaces.** *~1 week.*

The union rule and name qualification, implemented in `resolvePluginsForRun`.
`plugins.project`. The project Connectors tab (conditional, per R11.3). The
agent Tools tab with per-agent toggles written from the agent side.

*Delivers:* connectors attachable at every level the owner listed, with one
rule for what an agent ends up with.

---

**Phase 7 — Agent detail page, finished.** *~4 days.*

Delete `mcpConfig` (migration plus one form field). One skills editor, not two.
Skill source derived from the runtime's handshake with an honest unknown state
(D2). Inherited-value display (R12-P4.4). Probe codes as sentences with a fix
(R12-P4.5).

*Why after Phase 6:* the Tools tab is most of this screen's new content, and
building it twice would be the waste.

---

**Phase 8 — Audit and observability.** *~1 week.*

`actorType`/`actorId` on Activity. `workspace` and `organisation` columns
(removing three queries from the audit page — a D0 win). An access block making
it create-and-read only. Every write listed in §10. Connector call metering.

*Why not earlier:* an audit log is only worth writing once the events it should
record exist. Writing it first means writing it twice.

---

**Phase 9 — SaaS: our key, metering, spend enforcement.** *~2 weeks.*

Our Composio key with per-workspace token buckets on top of theirs (their limit
is per Composio organisation, so ours must be per tenant). Cost attribution
per workspace. Enforce `spendCapCents` in the dispatcher — the column has
existed unread since B7.2 and its own field description says so. Billing.

*Why last:* it is the only phase whose requirements come from a commercial
model that does not exist yet, and every input it needs (metering, org, roles,
audit) is delivered above.

---

## 12. Open questions for the owner

These are the decisions I could not take on your behalf. Each has my
recommendation and, where it matters, what would change my mind.

**Q1. Organisation above workspace, or workspace *is* the organisation?**
*Recommendation: org above.* It costs a table, a URL-invisible layer and a
backfill. It buys per-company billing, org-level runtimes and one place to keep
a Composio key. *What changes my mind:* if you are certain no customer will ever
want two workspaces on one invoice, workspace-as-org is a year cheaper and I
would take it.

**Q2. Better Auth's `teams` sub-feature — on or off?** *Recommendation: off.*
This repo already has a `teams` table that means "channel" and whose migration
explicitly declined to rename it. Two `team` tables in one schema is a wrong
join waiting to happen.

**Q3. Re-key Payload users onto Better Auth ids, or add a join column?**
*Recommendation: join column (`users.betterAuthId`).* Re-keying touches a real
FK on the broker's `runs` table, six Payload relationships and the audit trail,
for no functional gain.

**Q4. BYO Composio key first, or our key first?** *Recommendation: BYO first.*
Their rate limit is per Composio organisation, so our key means one shared
bucket across tenants and requires our own per-workspace limiter before it is
safe. BYO is also the only path where a security-conscious customer keeps
custody of their own OAuth apps, and self-managed credentials reportedly sit
behind a $599/mo tier (**VERIFY**).

**Q5. What does an organisation admin see about members' connections?**
*Recommendation: existence and status only* — "Priya connected Gmail on
3 September, active". Never a token, and never the third-party account's own
identity. A connected account is a person's grant against their own Google
account, and showing an admin more than the fact of it is a privacy decision
you would have to defend.

**Q6. Can an agent hold a connection of its *own* — a service account with no
human behind it?** *Recommendation: eventually yes, not in the first pass.* It
is genuinely useful for scheduled and unattended work. But it is the one thing
that breaks "an agent may never exceed its user", so it needs its own answer —
probably a distinct subject type with an explicit human sponsor recorded on it
— and that answer should not be improvised inside the connectors phase.

**Q7. Is the Composio key set per organisation or per workspace?**
*Recommendation: per organisation, with an optional per-workspace override.*
Rate limits and billing are org-scoped at Composio's end, so anything finer is
a fiction; but a workspace that needs isolation should be able to bring its own
rather than share the org's bucket.

**Q8. What happens to a run mid-turn when its accountable user leaves the
organisation?** *Recommendation: cancel it.* `cancel_requested_at` already
exists and the dispatcher already honours it. The alternative — letting it
finish — means work continues to be performed with the authority of someone who
has been removed, which is exactly the thing an offboarding process is for.

**Q9. Which email provider?** No transport exists in the repo, and Better Auth's
invitation flow needs one. This is a small decision that blocks Phase 1
entirely.

**Q10. Will this ever run as more than one process?** If yes, Phase 3 is not
optional and probably wants to move earlier. If genuinely never, Phase 3 is
still required for Phase 5 but the scaling argument drops away. The answer also
decides whether `lib/run-worktrees/manager.ts`'s in-process mutex needs
R12-P5.3's Postgres advisory lock or just an enforced boot-time assertion.

**Q11. Do connectors need to work for a Claude Code agent on day one, or is
Hermes enough?** Everything in §5's ownership rule is runtime-neutral, but
§9's skill picker is currently Hermes-shaped. If Claude Code matters at
launch, R12-P4.3's per-runtime settings grouping moves ahead of Phase 7.
