// One-off: bind an agent to the Claude Code ACP runtime.
//
// Kept as a script rather than done by hand in SQL so Payload's own defaults
// and hooks apply, exactly as they would if someone created the agent in the
// UI.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getPayloadClient } = await import('../lib/payload')

const profileId = Number(process.argv[2] ?? 7)
const name = process.argv[3] ?? 'Claude Code'

const payload = await getPayloadClient()
const profile = await payload.findByID({ collection: 'runtime-profiles', id: profileId, depth: 0, overrideAccess: true })
const workspaceId = typeof profile.workspace === 'number' ? profile.workspace : profile.workspace.id

const existing = await payload.find({
  collection: 'agents',
  where: { workspace: { equals: workspaceId }, name: { equals: name } },
  depth: 0,
  limit: 1,
  overrideAccess: true,
})
if (existing.docs.length > 0) {
  await payload.update({
    collection: 'agents',
    id: existing.docs[0].id,
    data: { runtimeProfile: profileId, enabled: true },
    overrideAccess: true,
  })
  console.log(`Updated existing agent ${existing.docs[0].id} (${name}) to runtime ${profileId}.`)
} else {
  const created = await payload.create({
    collection: 'agents',
    data: {
      workspace: workspaceId,
      name,
      runtimeProfile: profileId,
      thinkingLevel: 'medium',
      instructions:
        'You are a helpful engineering agent running inside NotionForge. Keep answers short and concrete.',
      // 'ask' so the first real turn exercises the approval path rather than
      // silently granting a brand new runtime whatever it asks for.
      permissionMode: 'ask',
      maxConcurrentRuns: 1,
      enabled: true,
    },
    overrideAccess: true,
  })
  console.log(`Created agent ${created.id} (${name}) on runtime ${profileId} in workspace ${workspaceId}.`)
}
