const MIB = 1024 * 1024

export type SandboxRuntime = 'runc' | 'runsc' | 'auto'
export type ResolvedSandboxRuntime = Exclude<SandboxRuntime, 'auto'>
export type SandboxNetworkMode = 'none' | 'internal'

export interface SandboxConfig {
  /** Host directory under which each workspace's files live (per-workspace subdir = <root>/<workspaceId>). */
  workspaceRoot: string
  /** Container image used for every sandbox session. */
  image: string
  /** Non-root user to run commands as inside the container. Must exist in the image. */
  containerUser: string
  /** Hard memory ceiling per container. */
  memoryLimitBytes: number
  /** CPU quota (fractional cores) per container. */
  cpuLimit: number
  /** Max number of processes (PIDs) per container. */
  pidsLimit: number
  /** Seconds Docker waits for a graceful stop before SIGKILL. */
  stopTimeoutSec: number
  /** Automatically destroy a session after this much idle time. */
  idleTimeoutMs: number
  /** Container runtime: 'runsc' requires gVisor, 'runc' explicitly accepts runc, or 'auto' chooses runsc only if installed. */
  runtime: SandboxRuntime
  /** Egress posture. 'none' = no network. 'internal' = isolated internal network with no internet routing. */
  networkMode: SandboxNetworkMode
  /** Name of the internal-only Docker network used when networkMode is 'internal'. */
  internalNetworkName: string
  /** True once we have confirmed gVisor/runsc is actually available on the host. */
  gVisorAvailable: boolean
}

const DEFAULT_CONFIG: SandboxConfig = {
  workspaceRoot: '.sandbox-workspaces',
  image: 'node:20-alpine',
  containerUser: 'node',
  memoryLimitBytes: 512 * MIB,
  cpuLimit: 1,
  pidsLimit: 256,
  stopTimeoutSec: 10,
  idleTimeoutMs: 15 * 60 * 1000,
  runtime: 'auto',
  networkMode: 'none',
  internalNetworkName: 'notionforge-sandbox',
  gVisorAvailable: false,
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function floatFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const runtimeRaw = (env.SANDBOX_RUNTIME ?? 'auto').toLowerCase()
  const runtime: SandboxRuntime = runtimeRaw === 'runsc' ? 'runsc' : runtimeRaw === 'runc' ? 'runc' : 'auto'
  const networkRaw = (env.SANDBOX_NETWORK ?? 'none').toLowerCase()
  const networkMode: SandboxNetworkMode = networkRaw === 'internal' ? 'internal' : 'none'

  return {
    ...DEFAULT_CONFIG,
    workspaceRoot: env.SANDBOX_WORKSPACE_ROOT ?? DEFAULT_CONFIG.workspaceRoot,
    image: env.SANDBOX_IMAGE ?? DEFAULT_CONFIG.image,
    containerUser: env.SANDBOX_CONTAINER_USER ?? DEFAULT_CONFIG.containerUser,
    memoryLimitBytes: intFromEnv(env.SANDBOX_MEMORY_BYTES, DEFAULT_CONFIG.memoryLimitBytes),
    cpuLimit: floatFromEnv(env.SANDBOX_CPU, DEFAULT_CONFIG.cpuLimit),
    pidsLimit: intFromEnv(env.SANDBOX_PIDS_LIMIT, DEFAULT_CONFIG.pidsLimit),
    stopTimeoutSec: intFromEnv(env.SANDBOX_STOP_TIMEOUT, DEFAULT_CONFIG.stopTimeoutSec),
    idleTimeoutMs: intFromEnv(env.SANDBOX_IDLE_TIMEOUT_MINUTES, 15) * 60 * 1000,
    runtime,
    networkMode,
    internalNetworkName: env.SANDBOX_INTERNAL_NETWORK ?? DEFAULT_CONFIG.internalNetworkName,
    gVisorAvailable: DEFAULT_CONFIG.gVisorAvailable,
  }
}
