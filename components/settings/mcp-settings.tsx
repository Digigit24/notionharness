'use client'

import { useState, useTransition } from 'react'
import { CheckCircle2, Loader2, Plug, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProfilePills } from './profile-pills'
import { setMcpEnabled, testMcp, type McpSettings, type McpTestResult } from '@/app/(app)/workspace/[workspaceSlug]/settings/mcp/actions'
import { formatCount } from '@/lib/relative-time'

/** Connected MCP tool servers for one Hermes profile. */
export function McpSettingsView({
  workspaceSlug,
  settings,
}: {
  workspaceSlug: string
  settings: McpSettings
}) {
  const [servers, setServers] = useState(settings.servers)
  const [error, setError] = useState<string | null>(settings.error)
  const [results, setResults] = useState<Record<string, McpTestResult>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [busy, startTransition] = useTransition()

  function toggle(name: string, enabled: boolean) {
    setServers((current) => current.map((s) => (s.name === name ? { ...s, enabled } : s)))
    setError(null)
    startTransition(async () => {
      try {
        await setMcpEnabled({ workspaceSlug, profile: settings.profile, name, enabled })
      } catch (err) {
        setServers((current) => current.map((s) => (s.name === name ? { ...s, enabled: !enabled } : s)))
        setError(err instanceof Error ? err.message : 'Could not change that server.')
      }
    })
  }

  function runTest(name: string) {
    setTesting(name)
    setError(null)
    startTransition(async () => {
      try {
        const result = await testMcp(settings.profile, name)
        setResults((current) => ({ ...current, [name]: result }))
      } finally {
        setTesting(null)
      }
    })
  }

  return (
    <main className="w-full max-w-4xl px-5 py-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">MCP servers</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          Tool servers this profile can call. Configured in the profile&apos;s own Hermes config, so what you see
          here is what an agent on that profile actually gets.
        </p>
      </header>

      <ProfilePills
        profiles={settings.profiles}
        active={settings.profile}
        basePath={`/workspace/${workspaceSlug}/settings/mcp`}
      />

      {error && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {servers.length === 0 && !error && (
        <p className="text-xs text-black/40 dark:text-white/40">
          No MCP servers configured for this profile. The catalog section has presets to install.
        </p>
      )}

      <ul className="divide-y divide-black/[0.06] rounded-lg border border-black/10 dark:divide-white/[0.08] dark:border-white/10">
        {servers.map((server) => {
          const result = results[server.name]
          return (
            <li key={server.name} className="px-3 py-2.5">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={(e) => toggle(server.name, e.target.checked)}
                  className="mt-1"
                  aria-label={`Enable ${server.name}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{server.name}</span>
                    <span className="shrink-0 rounded border border-black/10 px-1 text-[9px] uppercase text-black/40 dark:border-white/10 dark:text-white/40">
                      {server.transport}
                    </span>
                    {server.auth && (
                      <span className="shrink-0 text-[10px] text-black/35 dark:text-white/35">
                        auth: {server.auth}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-black/45 dark:text-white/45">
                    {server.url ?? [server.command, ...server.args].filter(Boolean).join(' ')}
                  </p>
                  {result && (
                    <p
                      className={`mt-1 flex items-start gap-1 text-[11px] ${
                        result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
                      }`}
                    >
                      {result.ok ? (
                        <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                      ) : (
                        <XCircle size={12} className="mt-0.5 shrink-0" />
                      )}
                      <span className="min-w-0">
                        {result.ok
                          ? `${formatCount(result.tools.length)} tools: ${result.tools.slice(0, 8).join(', ')}${
                              result.tools.length > 8 ? '…' : ''
                            }`
                          : result.error || 'The server did not respond.'}
                      </span>
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={busy && testing === server.name}
                  onClick={() => runTest(server.name)}
                >
                  {busy && testing === server.name ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Plug size={12} />
                  )}
                  Test
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </main>
  )
}
