import path from 'node:path'
import nextEnv from '@next/env'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

nextEnv.loadEnvConfig(path.resolve(process.cwd()))
const appUrl = (process.env.NOTIONFORGE_URL || 'http://localhost:3000').replace(/\/$/, '')
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null

async function api(pathname: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(`${appUrl}${pathname}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  const text = await response.text()
  let body: Json
  try { body = text ? JSON.parse(text) as Json : null } catch { body = text }
  if (!response.ok) throw new Error(`NotionForge API ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  return body
}
function result(body: Json) { return { content: [{ type: 'text' as const, text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }] } }
function failure(error: unknown) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] } }
async function safe<T>(fn: () => Promise<T>) { try { return result(await fn() as Json) } catch (error) { return failure(error) } }

const tableId = z.string().min(1).describe('The connected Teable table ID.')
const workspaceId = z.coerce.number().int().positive().describe('Payload workspace ID that scopes this operation.')
const server = new McpServer({ name: 'notionforge', version: '1.0.0' })

server.registerTool('list_teable_tables', { description: 'List Teable tables connected to a specific NotionForge workspace. Supply the Payload workspace ID to prevent cross-workspace reads.', inputSchema: { workspaceId } }, async ({ workspaceId: id }) => safe(async () => {
  const body = await api(`/api/teable-databases?workspaceId=${id}`)
  return body
}))
server.registerTool('get_table_schema', { description: 'Return the fields/properties configured on a connected Teable table.', inputSchema: { teableTableId: tableId } }, async ({ teableTableId }) => safe(() => api(`/api/teable/tables/${encodeURIComponent(teableTableId)}/fields`)))
server.registerTool('query_records', { description: 'Query records from a connected Teable table. Supports Teable search, filter, viewId, ordering, and pagination query syntax.', inputSchema: { teableTableId: tableId, search: z.string().optional(), filter: z.string().optional(), viewId: z.string().optional(), take: z.coerce.number().int().min(1).max(1000).optional(), skip: z.coerce.number().int().min(0).optional() } }, async ({ teableTableId, ...query }) => safe(() => { const qs = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined) qs.set(key, String(value)); return api(`/api/teable/tables/${encodeURIComponent(teableTableId)}/records?${qs}`) }))
server.registerTool('create_record', { description: 'Create one record in a connected Teable table. Fields are keyed by Teable field ID or field name according to the table API.', inputSchema: { teableTableId: tableId, fields: z.record(z.string(), z.unknown()) } }, async ({ teableTableId, fields }) => safe(() => api(`/api/teable/tables/${encodeURIComponent(teableTableId)}/records`, { method: 'POST', body: JSON.stringify({ fields }) })))
server.registerTool('update_record', { description: 'Update fields on one Teable record.', inputSchema: { teableTableId: tableId, recordId: z.string().min(1), fields: z.record(z.string(), z.unknown()) } }, async ({ teableTableId, recordId, fields }) => safe(() => api(`/api/teable/tables/${encodeURIComponent(teableTableId)}/records/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: JSON.stringify({ fields }) })))
server.registerTool('delete_record', { description: 'Permanently delete one Teable record after confirming its table and record IDs.', inputSchema: { teableTableId: tableId, recordId: z.string().min(1) } }, async ({ teableTableId, recordId }) => safe(() => api(`/api/teable/tables/${encodeURIComponent(teableTableId)}/records/${encodeURIComponent(recordId)}`, { method: 'DELETE' })))
server.registerTool('get_page', { description: 'Read a NotionForge page as clean Markdown. Supply its numeric page ID.', inputSchema: { pageId: z.coerce.number().int().positive() } }, async ({ pageId }) => safe(() => api(`/api/pages/${pageId}/export-markdown`)))
server.registerTool('update_page_content', { description: 'Replace a NotionForge page body with Markdown. Supply its numeric page ID and non-empty Markdown content.', inputSchema: { pageId: z.coerce.number().int().positive(), markdown: z.string().min(1) } }, async ({ pageId, markdown }) => safe(() => api(`/api/pages/${pageId}/import-markdown`, { method: 'POST', headers: { 'Content-Type': 'text/markdown; charset=utf-8' }, body: markdown })))

const transport = new StdioServerTransport()
await server.connect(transport)
