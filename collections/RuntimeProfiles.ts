import type { CollectionConfig } from 'payload'

export const RuntimeProfiles: CollectionConfig = {
  slug: 'runtime-profiles',
  admin: { useAsTitle: 'commandName' },
  fields: [
    { name: 'name', type: 'text', required: true, defaultValue: 'ACP runtime' },
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'protocolFamily', type: 'select', required: true, options: [{ label: 'ACP', value: 'acp' }, { label: 'MCP', value: 'mcp' }] },
    { name: 'commandName', type: 'text', required: true },
    { name: 'fixedArgs', type: 'json', defaultValue: [] },
    { name: 'enabled', type: 'checkbox', defaultValue: true },
    // What the agent said about itself during the ACP `initialize` handshake,
    // stored verbatim. Deliberately not mapped into flags we maintain: a
    // capability matrix in our own code goes stale the moment a CLI ships a
    // release, and every entry in it is a claim we cannot verify. Derive
    // capability answers from this (see `lib/runtimes/detect.ts`), and treat
    // its absence as "not probed yet", which is a different answer from "the
    // agent cannot do that".
    { name: 'handshake', type: 'json' },
    // Machine-readable probe outcome, not a translated sentence: 'ok',
    // 'command_not_found', 'acp_init_failed', 'acp_init_timeout',
    // 'spawn_failed'. A UI maps these to words; a log can be grepped for them.
    { name: 'lastProbeCode', type: 'text' },
    { name: 'lastProbeDetail', type: 'text' },
    { name: 'lastProbedAt', type: 'date' },
  ],
}

export default RuntimeProfiles
