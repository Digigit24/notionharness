import { DemoToolPair, type ToolPair } from '@/components/tool-catalogue/tool-components'

const examples: Array<{ label: string; pair: ToolPair }> = [
  {
    label: 'Bash / terminal',
    pair: {
      call: { type: 'tool_call', id: 'demo-bash', name: 'bash', input: { command: 'npm test' }, status: 'completed' },
      result: { type: 'tool_result', id: 'demo-bash', output: 'Tests: 18 passed\nTime: 2.4s', isError: false },
    },
  },
  {
    label: 'Edit / write diff',
    pair: {
      call: { type: 'tool_call', id: 'demo-edit', name: 'edit_file', input: { path: 'src/greeting.ts', diff: '-return "Hi"\n+return "Hello"' }, status: 'completed' },
      result: { type: 'tool_result', id: 'demo-edit', output: 'Updated src/greeting.ts', isError: false },
    },
  },
  {
    label: 'Read / grep summary',
    pair: {
      call: { type: 'tool_call', id: 'demo-read', name: 'grep', input: { pattern: 'TODO', path: 'src/' }, status: 'completed' },
      result: { type: 'tool_result', id: 'demo-read', output: 'src/app.ts\nsrc/lib/config.ts\nsrc/ui/button.tsx', isError: false },
    },
  },
  {
    label: 'Unknown tool / structured fallback',
    pair: {
      call: { type: 'tool_call', id: 'demo-unknown', name: 'deploy_preview', input: { environment: 'staging', region: 'us-east' }, status: 'completed' },
      result: { type: 'tool_result', id: 'demo-unknown', output: { deploymentId: 'preview-42', url: 'https://preview.example.test' }, isError: false },
    },
  },
]

export default function ToolCatalogueDemoPage() {
  return <main className="min-h-screen bg-background px-6 py-12 text-foreground"><div className="mx-auto max-w-3xl space-y-8"><header><h1 className="text-2xl font-semibold tracking-tight">Tool UI catalogue</h1><p className="mt-2 text-sm text-muted-foreground">Standalone previews for paired RunEvent tool calls and results. Unknown tools fall back to structured JSON.</p></header><div className="grid gap-6">{examples.map((example) => <DemoToolPair key={example.label} {...example} />)}</div></div></main>
}
