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

const server = new McpServer({ name: 'notionforge', version: '1.0.0' })

server.registerTool('get_page', { description: 'Read a NotionForge page as clean Markdown. Supply its numeric page ID.', inputSchema: { pageId: z.coerce.number().int().positive() } }, async ({ pageId }) => safe(() => api(`/api/pages/${pageId}/export-markdown`)))
server.registerTool('update_page_content', { description: 'Replace a NotionForge page body with Markdown. Supply its numeric page ID and non-empty Markdown content.', inputSchema: { pageId: z.coerce.number().int().positive(), markdown: z.string().min(1) } }, async ({ pageId, markdown }) => safe(() => api(`/api/pages/${pageId}/import-markdown`, { method: 'POST', headers: { 'Content-Type': 'text/markdown; charset=utf-8' }, body: markdown })))

const transport = new StdioServerTransport()
await server.connect(transport)
