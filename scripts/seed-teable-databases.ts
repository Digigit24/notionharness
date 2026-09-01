import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function teable(path: string, init: RequestInit = {}) {
  const apiUrl = process.env.TEABLE_API_URL?.replace(/\/$/, '')
  const apiKey = process.env.TEABLE_API_KEY
  if (!apiUrl || !apiKey) throw new Error('TEABLE_API_URL and TEABLE_API_KEY are required')
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  const res = await fetch(`${apiUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  const text = await res.text()
  const body: unknown = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} failed (${res.status}): ${JSON.stringify(body)}`)
  return body
}
function list(body: unknown): Array<{ id: string; name: string; type?: string }> {
  if (Array.isArray(body)) return body as Array<{ id: string; name: string; type?: string }>
  if (body && typeof body === 'object') {
    const value = body as { data?: unknown; items?: unknown; list?: unknown; [key: string]: unknown }
    const result = value.data || value.items || value.list || value.bases || value.spaces || value.tables || value.records || value.fields || value.views
    return Array.isArray(result) ? result as Array<{ id: string; name: string; type?: string }> : []
  }
  return []
}

const choices = [
  { name: 'To-do', color: 'gray' },
  { name: 'In Progress', color: 'blue' },
  { name: 'Done', color: 'green' },
]
const tableSpecs = [
  { name: 'Projects', fields: [
    { name: 'Name', type: 'singleLineText', isPrimary: true },
    { name: 'Status', type: 'singleSelect', options: { choices } },
    { name: 'Owner', type: 'user' }, { name: 'Due Date', type: 'date' },
  ], records: [
    { Name: 'Website redesign', Status: 'In Progress', 'Due Date': '2026-10-15' },
    { Name: 'Mobile app launch', Status: 'To-do', 'Due Date': '2026-11-01' },
    { Name: 'Analytics migration', Status: 'Done', 'Due Date': '2026-08-20' },
  ] },
  { name: 'Tasks', fields: [
    { name: 'Name', type: 'singleLineText', isPrimary: true },
    { name: 'Status', type: 'singleSelect', options: { choices } },
    { name: 'Assignee', type: 'user' }, { name: 'Due Date', type: 'date' },
    { name: 'Priority', type: 'singleSelect', options: { choices: [{ name: 'Low', color: 'gray' }, { name: 'Medium', color: 'blue' }, { name: 'High', color: 'red' }] } },
  ], records: [
    { Name: 'Audit current pages', Status: 'Done', Priority: 'High' }, { Name: 'Draft wireframes', Status: 'In Progress', Priority: 'High' },
    { Name: 'Set up CI pipeline', Status: 'To-do', Priority: 'Medium' }, { Name: 'Write launch copy', Status: 'To-do', Priority: 'Low' },
    { Name: 'Migrate event tracking', Status: 'Done', Priority: 'Medium' }, { Name: 'QA mobile navigation', Status: 'In Progress', Priority: 'High' },
  ] },
]

export async function seedTeableDatabases() {
  const { getPayloadClient } = await import('../lib/payload')
  const accessibleBases = process.env.TEABLE_BASE_ID ? [] : list(await teable('/base/access/all'))
  let base = (process.env.TEABLE_BASE_ID ? { id: process.env.TEABLE_BASE_ID, name: 'Configured base' } : accessibleBases.find((item) => item.name === 'NotionForge Demo')) as { id: string; name: string } | undefined
  if (!base) {
    const spaces = list(await teable('/space'))
    const existingSpace = spaces.find((item) => item.name === 'NotionForge')
    if (!existingSpace) throw new Error('No accessible base found. Create a space/base in Teable UI, then set TEABLE_BASE_ID in .env before rerunning.')
    const space = existingSpace as { id: string; name: string }
    const bases = list(await teable(`/space/${space.id}/base`))
    base = (bases.find((item) => item.name === 'NotionForge Demo') || await teable('/base', { method: 'POST', body: JSON.stringify({ name: 'NotionForge Demo', spaceId: space.id }) })) as { id: string; name: string }
  }
  const payload = await getPayloadClient()
  const workspaces = await payload.find({ collection: 'workspaces', limit: 1, overrideAccess: true })
  let workspace = workspaces.docs[0]
  if (!workspace) {
    const users = await payload.find({ collection: 'users', limit: 1, overrideAccess: true })
    const owner = users.docs[0] || await payload.create({ collection: 'users', data: { email: 'seed@notionforge.local', password: crypto.randomUUID() }, draft: true, overrideAccess: true })
    workspace = await payload.create({ collection: 'workspaces', data: { name: 'Demo', slug: 'demo', owner: owner.id }, overrideAccess: true })
  }
  const seeded: Array<{ name: string; tableId: string; fieldCount: number; recordCount: number }> = []
  for (const spec of tableSpecs) {
    const tables = list(await teable(`/base/${base.id}/table`))
    const table = (tables.find((item) => item.name === spec.name) || await teable(`/base/${base.id}/table`, { method: 'POST', body: JSON.stringify({ name: spec.name }) })) as { id: string; name: string }
    const existingFields = list(await teable(`/table/${table.id}/field`))
    for (const field of spec.fields) {
      const existingField = existingFields.find((item) => item.name === field.name)
      if (!existingField) await teable(`/table/${table.id}/field`, { method: 'POST', body: JSON.stringify(field) })
      else if (field.options && existingField.type === field.type) await teable(`/table/${table.id}/field/${existingField.id}`, { method: 'PATCH', body: JSON.stringify({ options: field.options }) })
    }
    let existing = list(await teable(`/table/${table.id}/record?take=1000`))
    const blankRecords = existing.filter((record) => !record.name && !Object.keys((record as unknown as { fields?: Record<string, unknown> }).fields || {}).length)
    if (existing.length && blankRecords.length === existing.length) {
      for (const record of blankRecords) await teable(`/table/${table.id}/record/${record.id}`, { method: 'DELETE' })
      existing = []
    }
    if (!existing.length) {
      await teable(`/table/${table.id}/record`, { method: 'POST', body: JSON.stringify({ fieldKeyType: 'name', records: spec.records.map((fields) => ({ fields })) }) })
    }
    const finalFields = list(await teable(`/table/${table.id}/field`))
    const finalRecords = list(await teable(`/table/${table.id}/record?take=1000`))
    const existingPayload = await payload.find({ collection: 'teable-databases', where: { teableTableId: { equals: table.id } }, limit: 1, overrideAccess: true })
    if (!existingPayload.docs[0]) {
      const data: Record<string, unknown> = { name: spec.name, workspace: workspace.id, teableTableId: table.id, teableBaseId: base.id }
      await payload.create({ collection: 'teable-databases', data: data as never, overrideAccess: true })
    }
    seeded.push({ name: spec.name, tableId: table.id, fieldCount: finalFields.length, recordCount: finalRecords.length })
  }
  return { baseId: base.id, workspaceId: workspace.id, tables: seeded }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  import('@next/env').then(({ default: nextEnv }) => {
    nextEnv.loadEnvConfig(path.resolve(process.cwd()))
    return seedTeableDatabases()
  }).then((summary) => console.log(JSON.stringify(summary))).catch((error) => { console.error(error); process.exitCode = 1 })
}
