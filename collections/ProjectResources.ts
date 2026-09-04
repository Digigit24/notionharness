import type { CollectionConfig } from 'payload'
import { inMyAdministeredWorkspaces, inMyWorkspaces } from './access'

// Phase C, C1.6/§02 — "a project holds several folders, not one." A
// project's substance (a git repo, a docs folder, a scratch dir) modeled as
// its own collection rather than columns on `Projects` itself, since a
// project can have more than one and each needs its own kind/role/writable
// triple. NOT YET REGISTERED in payload.config.ts — see migrations/
// <this file's matching migration>'s own comment for why (same schema-
// gating discipline as `globals/HermesConfig.ts`).
//
// Four decisions from the roadmap doc's own §02, each free now and painful
// later:
//   - Exactly one `primary` per project, enforced by a partial unique index
//     in the migration (`role = 'primary'`), not just app-level discipline
//     — "where does the agent start?" must never be ambiguous.
//   - `writable` is a real safety property (the repo is writable, a docs
//     folder is reference-only), not decoration — it's meant to map
//     straight onto container mount modes (ro/rw) if Hermes's docker
//     backend is ever enabled.
//   - Worktrees apply only to the primary git resource; reference/output/
//     scratch folders are used in place — a runtime-logic decision, not a
//     schema one, so nothing here encodes it directly.
//   - `path` lives on the RUNTIME's filesystem, not the browser's — the
//     browser can't see it, so `lastVerifiedAt`/`exists` exist so the UI
//     can warn quietly when a folder moves instead of failing mid-run.
export const ProjectResources: CollectionConfig = {
  slug: 'project-resources',
  // One hop, through the project. Writing one names a real directory or repo
  // on this host that agents are then allowed to touch, so writes are
  // `administer`-level even though reads are ordinary workspace business.
  access: {
    read: inMyWorkspaces('project.workspace'),
    create: inMyAdministeredWorkspaces('project.workspace'),
    update: inMyAdministeredWorkspaces('project.workspace'),
    delete: inMyAdministeredWorkspaces('project.workspace'),
  },
  admin: { useAsTitle: 'path' },
  fields: [
    { name: 'project', type: 'relationship', relationTo: 'projects', required: true, index: true },
    {
      name: 'kind',
      type: 'select',
      required: true,
      options: [
        { label: 'Git repo', value: 'git_repo' },
        { label: 'Local directory', value: 'local_dir' },
      ],
    },
    {
      name: 'path',
      type: 'text',
      admin: {
        description:
          "Absolute path on the runtime's filesystem — not the browser's. Empty for a git_repo not yet materialized (app-managed clones live under the runtime's workspace root, see AGENTS.md's Phase C notes).",
      },
    },
    { name: 'repoUrl', type: 'text', admin: { description: 'git_repo only.' } },
    { name: 'defaultBranch', type: 'text', admin: { description: 'git_repo only.' } },
    {
      name: 'role',
      type: 'select',
      required: true,
      options: [
        { label: 'Primary', value: 'primary' },
        { label: 'Reference', value: 'reference' },
        { label: 'Output', value: 'output' },
        { label: 'Scratch', value: 'scratch' },
      ],
      admin: {
        description: 'Exactly one primary per project — enforced by a DB constraint, not just this field.',
      },
    },
    { name: 'writable', type: 'checkbox', defaultValue: true },
    { name: 'position', type: 'number', admin: { description: 'Display order among a project\'s resources.' } },
    { name: 'lastVerifiedAt', type: 'date', admin: { readOnly: true } },
    {
      name: 'exists',
      type: 'checkbox',
      admin: { readOnly: true, description: "Set by the runtime's last verification pass, not asserted by the browser." },
    },
  ],
}

export default ProjectResources
