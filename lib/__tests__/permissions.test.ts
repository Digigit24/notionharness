import { describe, expect, it } from 'vitest'

import {
  canDeleteWorkspace,
  effectiveAgentRole,
  grantRoleAllows,
  grantRoleFromWorkspaceRole,
  refusalMessage,
  strongerWorkspaceRole,
  weakerGrantRole,
  workspaceRoleAllows,
  GRANT_ROLES,
  WORKSPACE_ROLES,
  type GrantRole,
  type Verb,
} from '@/lib/permissions/model'

/**
 * The permission rules, tested where getting them wrong is a security bug
 * rather than an inconvenience.
 *
 * `model.ts` is deliberately free of database access so this can exist: the
 * rules are pure functions over roles, and the enforcement layer that reads
 * Postgres is a separate file. A permission model that can only be tested
 * against a live database is one that gets tested once.
 */

describe('the intersection rule', () => {
  it('gives an agent the WEAKER of its own role and the accountable user’s', () => {
    // The whole point. An agent granted admin, run by a viewer, acts as a
    // viewer — otherwise "give the agent Slack" is a privilege-escalation path
    // where a read-only member triggers a run that posts as an admin.
    expect(effectiveAgentRole('admin', 'viewer')).toBe('viewer')
    expect(effectiveAgentRole('viewer', 'admin')).toBe('viewer')
    expect(effectiveAgentRole('editor', 'admin')).toBe('editor')
    expect(effectiveAgentRole('admin', 'admin')).toBe('admin')
  })

  it('is never the union, for any pair of roles', () => {
    // Exhaustive rather than illustrative: this is the rule that must not bend,
    // so it is asserted across the whole 3x3 space rather than at three points.
    for (const agentRole of GRANT_ROLES) {
      for (const userRole of GRANT_ROLES) {
        const effective = effectiveAgentRole(agentRole, userRole)
        expect(effective).toBe(weakerGrantRole(agentRole, userRole))
        // and never stronger than either side
        for (const verb of ['read', 'write', 'delete', 'execute', 'share'] as Verb[]) {
          if (grantRoleAllows(effective as GrantRole, verb)) {
            expect(grantRoleAllows(agentRole, verb)).toBe(true)
            expect(grantRoleAllows(userRole, verb)).toBe(true)
          }
        }
      }
    }
  })

  it('refuses entirely when either side has no access', () => {
    // An agent with no grant gets nothing even from an owner: an agent's reach
    // must be given deliberately, not inherited from whoever pressed the button.
    expect(effectiveAgentRole(null, 'admin')).toBeNull()
    // And a person with no access cannot borrow the agent's.
    expect(effectiveAgentRole('admin', null)).toBeNull()
    expect(effectiveAgentRole(null, null)).toBeNull()
  })
})

describe('workspace roles', () => {
  it('lets a viewer read and nothing else', () => {
    expect(workspaceRoleAllows('viewer', 'read')).toBe(true)
    for (const verb of ['write', 'delete', 'execute', 'share', 'administer'] as Verb[]) {
      expect(workspaceRoleAllows('viewer', verb)).toBe(false)
    }
  })

  it('lets a member work but not share or administer', () => {
    // The line that matters: a member can spend agent turns and edit content,
    // and cannot change who else gets in or what the workspace connects to.
    expect(workspaceRoleAllows('member', 'execute')).toBe(true)
    expect(workspaceRoleAllows('member', 'write')).toBe(true)
    expect(workspaceRoleAllows('member', 'share')).toBe(false)
    expect(workspaceRoleAllows('member', 'administer')).toBe(false)
    expect(workspaceRoleAllows('member', 'delete')).toBe(false)
  })

  it('separates deleting the workspace from every other admin power', () => {
    // `admin` can do everything `owner` can except this, and it is a function
    // rather than a verb so it cannot be satisfied by `administer`.
    expect(workspaceRoleAllows('admin', 'administer')).toBe(true)
    expect(canDeleteWorkspace('admin')).toBe(false)
    expect(canDeleteWorkspace('owner')).toBe(true)
    expect(canDeleteWorkspace(null)).toBe(false)
  })

  it('orders roles so two sources of access combine predictably', () => {
    expect(strongerWorkspaceRole('viewer', 'admin')).toBe('admin')
    expect(strongerWorkspaceRole('owner', 'admin')).toBe('owner')
    expect(strongerWorkspaceRole('member', 'viewer')).toBe('member')
  })

  it('maps membership onto the grant scale without over-granting', () => {
    // A member becomes `editor`, NOT `admin`: being in a workspace lets you
    // work in it, not re-share everything in it.
    expect(grantRoleFromWorkspaceRole('member')).toBe('editor')
    expect(grantRoleFromWorkspaceRole('viewer')).toBe('viewer')
    expect(grantRoleFromWorkspaceRole('admin')).toBe('admin')
    expect(grantRoleFromWorkspaceRole('owner')).toBe('admin')
  })

  it('has no role that can execute without being able to read', () => {
    // A sanity property over the whole matrix: every role's verb set must be
    // coherent, because a role that can act on a thing it cannot see is a bug
    // in the table rather than in any one check.
    for (const role of WORKSPACE_ROLES) {
      for (const verb of ['write', 'delete', 'execute', 'share'] as Verb[]) {
        if (workspaceRoleAllows(role, verb)) expect(workspaceRoleAllows(role, 'read')).toBe(true)
      }
    }
    for (const role of GRANT_ROLES) {
      for (const verb of ['write', 'delete', 'execute', 'share'] as Verb[]) {
        if (grantRoleAllows(role, verb)) expect(grantRoleAllows(role, 'read')).toBe(true)
      }
    }
  })
})

describe('refusals', () => {
  it('names the role you have, so the message is actionable', () => {
    // "Forbidden" tells somebody nothing about what to do next.
    const message = refusalMessage({ verb: 'administer', objectType: 'workspace', currentRole: 'member' })
    expect(message).toContain('member')
    expect(message).toContain('settings')
  })

  it('does not name a role when there is no access at all', () => {
    // Saying "you are a nothing here" is worse than saying you have no access,
    // and leaking that the object exists is its own small problem.
    expect(refusalMessage({ verb: 'read', objectType: 'project', currentRole: null })).toBe(
      'You do not have access to this project.',
    )
  })
})
