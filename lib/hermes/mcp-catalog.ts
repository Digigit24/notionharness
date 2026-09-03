// Phase C, C2 — "MCP connector gallery... Hermes ships 70+ presets in
// optional-mcps/ — Notion, Figma, Stripe, Supabase, Linear, Sentry — so a
// connector gallery is a grid view over data already on disk." Confirmed
// on this machine (see AGENTS.md's Phase C notes): this specific Hermes
// checkout bundles 5 (linear, figma, comfy-cloud, n8n, unreal-engine), not
// 70+ — the doc's number describes Hermes's fuller ecosystem, not what
// happens to be vendored in this one install. Real either way: these are
// genuine, Nous-approved manifest files, not fixtures.
//
// Read-only, deliberately: this module never triggers an install or writes
// a `mcp_servers.<name>` block into the live Hermes config — actually
// connecting a server needs the working Hermes API (still unconfirmed on
// this machine, see AGENTS.md) and is a real, separate write to the same
// live install Personalities' switch already touches carefully. Browsing
// what's available is safe and useful on its own.

import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

export interface McpCatalogEntry {
  slug: string
  name: string
  description: string
  source?: string
  transportType?: string
  authType?: string
  postInstall?: string
}

function catalogDir(): string {
  const home = process.env.HERMES_HOME_BASE
  if (!home) throw new Error('HERMES_HOME_BASE is not configured.')
  return path.join(home, 'hermes-agent', 'optional-mcps')
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export async function listMcpCatalog(): Promise<McpCatalogEntry[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(catalogDir(), { withFileTypes: true })
  } catch {
    return []
  }

  const results = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (dir): Promise<McpCatalogEntry | null> => {
        try {
          const raw = await fs.readFile(path.join(catalogDir(), dir.name, 'manifest.yaml'), 'utf-8')
          const doc = parse(raw) as Record<string, unknown>
          const transport = (doc.transport ?? {}) as Record<string, unknown>
          const auth = (doc.auth ?? {}) as Record<string, unknown>
          return {
            slug: dir.name,
            name: stringField(doc.name) ?? dir.name,
            description: stringField(doc.description) ?? '',
            source: stringField(doc.source),
            transportType: stringField(transport.type),
            authType: stringField(auth.type),
            postInstall: stringField(doc.post_install),
          }
        } catch {
          return null
        }
      }),
  )

  return results
    .filter((r): r is McpCatalogEntry => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}
