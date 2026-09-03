import type { Access, CollectionConfig, Where } from 'payload'

// This collection previously had no `access` at all, which Payload defaults
// to fully open (`() => true`) for every operation on the public REST/
// GraphQL API (`app/(payload)/api/[...slug]/route.ts`) — an unauthenticated
// internet request could read, create, update, or delete any workspace
// document. The app's own server actions/pages never rely on this (they all
// call the Payload Local API with `overrideAccess: true`, e.g. lib/pages-
// cache.ts's getWorkspaceBySlug), so this only closes that public-API
// surface; it does not replace the ownership check that now lives in
// app/(app)/page.tsx and app/(app)/workspace/[workspaceSlug]/layout.tsx —
// those guard the app's own queries, this guards Payload's own API/admin
// panel.
const isAdmin = (user: { role?: string | null } | null | undefined) => user?.role === 'admin'

const canReadOrUpdate: Access = ({ req }) => {
  if (!req.user) return false
  if (isAdmin(req.user)) return true
  const where: Where = {
    or: [{ owner: { equals: req.user.id } }, { members: { contains: req.user.id } }],
  }
  return where
}

const isOwnerOrAdmin: Access = ({ req }) => {
  if (!req.user) return false
  if (isAdmin(req.user)) return true
  return { owner: { equals: req.user.id } }
}

export const Workspaces: CollectionConfig = {
  slug: 'workspaces',
  access: {
    read: canReadOrUpdate,
    update: canReadOrUpdate,
    delete: isOwnerOrAdmin,
    create: ({ req }) => Boolean(req.user),
  },
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'icon',
      type: 'text',
      admin: {
        description: 'Emoji or icon identifier',
      },
    },
    {
      name: 'owner',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      hasMany: false,
    },
    {
      name: 'members',
      type: 'relationship',
      relationTo: 'users',
      hasMany: true,
    },
    {
      name: 'taskPrefix',
      type: 'text',
      admin: {
        description: 'Short, human-readable task-id prefix for this workspace (e.g. "ENG") — combined with taskCounter for IDs like ENG-142. Not yet surfaced in any UI.',
      },
    },
    {
      name: 'taskCounter',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Last-issued sequence number for this workspace\'s human-readable task IDs — increment and read atomically when actually wiring ENG-142-style IDs.',
      },
    },
    {
      // ROADMAP B7.2 (Batch B-6 "Finish") — paired with
      // migrations/20260902_150000_spend_caps.ts's spend_cap_cents column;
      // both land together, never as two separate steps (see that
      // migration's own header comment for why — `workspaces` is read on
      // nearly every page load). NULL/unset = uncapped. Dispatcher-side
      // fail-closed enforcement is a separate, still-unbuilt gap — see
      // components/workspace/spend-cap-form.tsx's own caveat.
      name: 'spendCapCents',
      type: 'number',
      min: 0,
      admin: {
        description: 'Monthly spend cap in cents for this workspace, or empty for uncapped. Not yet enforced by the dispatcher (see AGENTS.md B-6 entry).',
      },
    },
  ],
}

export default Workspaces
