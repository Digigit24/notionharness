import type { CollectionConfig } from 'payload'
import { inMyAdministeredWorkspaces, inMyWorkspaces } from './access'

export const RuntimeProfiles: CollectionConfig = {
  slug: 'runtime-profiles',
  // A profile names a binary and its arguments on THIS host. Reading one is
  // ordinary workspace business; writing one decides what this machine
  // executes, which is `administer`.
  access: {
    read: inMyWorkspaces(),
    create: inMyAdministeredWorkspaces(),
    update: inMyAdministeredWorkspaces(),
    delete: inMyAdministeredWorkspaces(),
  },
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
    // How this runtime gives an agent its identity on disk. Explicit rather
    // than guessed from the agent's name: string-matching 'hermes' out of a
    // handshake is exactly the kind of rule that rots on someone else's
    // release. 'none' is honest for a runtime with no relocatable home — the
    // agent still gets its instructions, because those go in the prompt.
    {
      name: 'homeStrategy',
      type: 'select',
      defaultValue: 'hermes',
      options: [
        { label: 'Hermes agent home', value: 'hermes' },
        { label: 'No agent home', value: 'none' },
      ],
    },
    { name: 'handshake', type: 'json' },
    // R12-P4.1 - what this runtime does unless an agent says otherwise.
    //
    // Same flat `{ [configId]: value }` shape as `agents.runtimeConfig`,
    // because the dispatcher merges the two and a second shape would mean a
    // translation step between them. The ids come from the runtime's own
    // handshake (`sessionConfigOptions`), so nothing here names a specific CLI
    // or a specific model - a runtime that ships a new option gets it for free
    // at the next probe.
    { name: 'defaultSessionConfig', type: 'json', defaultValue: {} },
    // Machine-readable probe outcome, not a translated sentence: 'ok',
    // 'command_not_found', 'acp_init_failed', 'acp_init_timeout',
    // 'spawn_failed'. A UI maps these to words; a log can be grepped for them.
    { name: 'lastProbeCode', type: 'text' },
    { name: 'lastProbeDetail', type: 'text' },
    { name: 'lastProbedAt', type: 'date' },
  ],
}

export default RuntimeProfiles
