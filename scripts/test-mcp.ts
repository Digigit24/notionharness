import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'scripts/notionforge-mcp.ts'] })
const client = new Client({ name: 'notionforge-smoke-test', version: '1.0.0' })
await client.connect(transport)
const tools = await client.listTools()
console.log('MCP tools:', tools.tools.map((tool) => tool.name).join(', '))
for (const id of ['tblilvkfz5TqjImNYo3', 'tblZg1dVdYKpphEqu1b']) {
  const schema = await client.callTool({ name: 'get_table_schema', arguments: { teableTableId: id } })
  const records = await client.callTool({ name: 'query_records', arguments: { teableTableId: id, take: 100 } })
  const schemaContent = (schema as unknown as { content?: Array<{ text?: string }> }).content
  const recordContent = (records as unknown as { content?: Array<{ text?: string }> }).content
  const schemaText = String(schemaContent?.[0]?.text || '[]')
  const recordText = String(recordContent?.[0]?.text || '{}')
  const parsedRecords = JSON.parse(recordText) as { records?: Array<{ fields?: Record<string, unknown> }> }
  console.log(`${id} MCP schema/records:`, JSON.parse(schemaText).length, parsedRecords.records?.length || 0, JSON.stringify(parsedRecords.records?.[0]?.fields || {}))
}
await client.close()
