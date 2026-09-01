import Docker from 'dockerode'
import { randomBytes } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { PassThrough } from 'node:stream'
import { once } from 'node:events'
import { loadSandboxConfig, type SandboxConfig } from './config'
import { sandboxLogger } from './logger'

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SandboxSession {
  sessionId: string
  workspaceId: string
  containerId: string
  containerName: string
  workspacePath: string
  createdAt: number
  lastActivityAt: number
}

export class SandboxError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SandboxError'
    this.code = code
  }
}

const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]+$/

class SandboxOrchestrator {
  private readonly config: SandboxConfig
  private docker: Docker | null = null
  private readonly sessions = new Map<string, SandboxSession>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private gVisorChecked = false
  private internalNetworkEnsured = false

  constructor(config: SandboxConfig = loadSandboxConfig()) {
    this.config = config
  }

  private getDocker(): Docker {
    if (!this.docker) this.docker = new Docker()
    return this.docker
  }

  /** Returns the runtime string to pass to Docker, resolving auto/runsc against the host. */
  private async resolveRuntime(): Promise<string> {
    if (this.config.runtime === 'runc') {
      this.config.gVisorAvailable = false
      return 'runc'
    }
    const docker = this.getDocker()
    if (!this.gVisorChecked) {
      this.gVisorChecked = true
      let available = false
      try {
        const info = await docker.info()
        const runtimes: Record<string, unknown> = (info.Runtimes ?? {}) as Record<string, unknown>
        available = Boolean(runtimes['runsc'])
      } catch (err) {
        sandboxLogger.warn('sandbox.runtime_check_failed', { error: String(err) })
      }
      this.config.gVisorAvailable = available
      if (this.config.runtime === 'runsc' && !available) {
        sandboxLogger.warn('sandbox.gvisor_unavailable_falling_back_to_runc', {
          reason: 'runsc runtime requested via config but not installed on host',
        })
      }
    }
    return this.config.gVisorAvailable ? 'runsc' : 'runc'
  }

  private async ensureInternalNetwork(): Promise<void> {
    const docker = this.getDocker()
    if (this.internalNetworkEnsured) return
    try {
      const network = docker.getNetwork(this.config.internalNetworkName)
      await network.inspect()
    } catch {
      try {
        await docker.createNetwork({
          Name: this.config.internalNetworkName,
          Driver: 'bridge',
          Internal: true,
        })
        sandboxLogger.info('sandbox.internal_network_created', {
          networkName: this.config.internalNetworkName,
        })
      } catch (err) {
        sandboxLogger.warn('sandbox.internal_network_create_failed', { error: String(err) })
      }
    }
    this.internalNetworkEnsured = true
  }

  private async workspaceHostPath(workspaceId: string): Promise<string> {
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      throw new SandboxError('invalid_workspace_id', `Workspace id contains disallowed characters: ${workspaceId}`)
    }
    const absolute = resolvePath(this.config.workspaceRoot, workspaceId)
    await mkdir(absolute, { recursive: true })
    // Canonicalize so the bind mount uses the real, absolute path.
    return realpath(absolute)
  }

  private containerName(sessionId: string): string {
    return `notionforge-sandbox-${sessionId}`
  }

  async createSession(workspaceId: string): Promise<SandboxSession> {
    const docker = this.getDocker()
    const config = this.config

    const runtime = await this.resolveRuntime()
    if (config.networkMode === 'internal') await this.ensureInternalNetwork()

    const sessionId = randomBytes(8).toString('hex')
    const sessionKey = sessionId
    const containerName = this.containerName(sessionId)
    const workspacePath = await this.workspaceHostPath(workspaceId)

    const tmpfs: Record<string, string> = {
      '/tmp': `rw,size=${Math.max(64 * 1024 * 1024, Math.floor(config.memoryLimitBytes / 4))},nosuid`,
      [`/home/${config.containerUser}`]: 'rw,size=64m,nosuid',
    }

    const hostConfig: Docker.HostConfig = {
      Binds: [`${workspacePath}:/workspace:rw`],
      ReadonlyRootfs: true,
      Tmpfs: tmpfs,
      Memory: config.memoryLimitBytes,
      NanoCpus: Math.round(config.cpuLimit * 1e9),
      PidsLimit: config.pidsLimit,
      // Stop timeout is applied at stop() time (see destroySession) using config.stopTimeoutSec.
      Runtime: runtime,
      NetworkMode: config.networkMode === 'internal' ? config.internalNetworkName : 'none',
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      Init: true,
    }

    const container = await docker.createContainer({
      name: containerName,
      Image: config.image,
      WorkingDir: '/workspace',
      User: config.containerUser,
      Cmd: ['/bin/sh', '-c', 'trap "exit 0" TERM; while :; do sleep 3600 & wait $!; done'],
      Hostname: sessionId.slice(0, 12),
      HostConfig: hostConfig,
      Env: ['HOME=/tmp', `WORKSPACE_ID=${workspaceId}`],
      Labels: {
        'notionforge.component': 'sandbox',
        'notionforge.session': sessionId,
        'notionforge.workspace': workspaceId,
      },
    })

    const internal: SandboxSession = {
      sessionId,
      workspaceId,
      containerId: container.id,
      containerName,
      workspacePath,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    }

    try {
      await container.start()
    } catch (err) {
      await container.remove({ force: true }).catch(() => undefined)
      sandboxLogger.error('sandbox.session_start_failed', {
        sessionId,
        workspaceId,
        error: String(err),
      })
      throw new SandboxError('container_start_failed', `Failed to start sandbox container: ${String(err)}`)
    }

    this.sessions.set(sessionKey, internal)
    this.scheduleIdleTimer(sessionKey)
    sandboxLogger.info('sandbox.session_created', {
      event: 'sandbox.session_created',
      sessionId,
      workspaceId,
      containerId: container.id,
      containerName,
      runtime,
      networkMode: config.networkMode,
    })

    return {
      sessionId,
      workspaceId,
      containerId: container.id,
      containerName,
      workspacePath,
      createdAt: internal.createdAt,
      lastActivityAt: internal.lastActivityAt,
    }
  }

  private requireSession(sessionId: string): SandboxSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new SandboxError('session_not_found', `No active sandbox session: ${sessionId}`)
    return session
  }

  async execInSession(sessionId: string, command: string): Promise<ExecResult> {
    const session = this.requireSession(sessionId)
    const container = this.getDocker().getContainer(session.containerId)

    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: this.config.containerUser,
      Env: ['HOME=/tmp', `WORKSPACE_ID=${session.workspaceId}`],
    })

    const stream = (await exec.start({ Detach: false, Tty: false, stdin: false })) as NodeJS.ReadableStream

    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    const containerModem = container.modem as unknown as { demuxStream: (s: NodeJS.ReadableStream, o: NodeJS.WritableStream, e: NodeJS.WritableStream) => void }
    containerModem.demuxStream(stream, stdout, stderr)

    await once(stream, 'end')

    const inspect = await exec.inspect()
    const exitCode = typeof inspect.ExitCode === 'number' ? inspect.ExitCode : -1

    session.lastActivityAt = Date.now()
    this.refreshIdleTimer(session.sessionId)

    sandboxLogger.info('sandbox.session_exec', {
      event: 'sandbox.session_exec',
      sessionId,
      workspaceId: session.workspaceId,
      containerId: session.containerId,
      exitCode,
      command,
    })

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const docker = this.getDocker()
    this.clearIdleTimer(sessionId)
    try {
      const container = docker.getContainer(session.containerId)
      await container.stop({ t: this.config.stopTimeoutSec }).catch(() => undefined)
      await container.remove({ force: true })
      sandboxLogger.info('sandbox.session_destroyed', {
        event: 'sandbox.session_destroyed',
        sessionId,
        workspaceId: session.workspaceId,
        containerId: session.containerId,
        containerName: session.containerName,
      })
    } catch (err) {
      sandboxLogger.warn('sandbox.session_destroy_failed', {
        sessionId,
        workspaceId: session.workspaceId,
        error: String(err),
      })
    } finally {
      this.sessions.delete(sessionId)
    }
  }

  async destroyAllSessions(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.destroySession(id)))
  }

  listSessions(): SandboxSession[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      containerId: session.containerId,
      containerName: session.containerName,
      workspacePath: session.workspacePath,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    }))
  }

  private scheduleIdleTimer(sessionId: string) {
    this.clearIdleTimer(sessionId)
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      const idleMs = Date.now() - session.lastActivityAt
      if (idleMs >= this.config.idleTimeoutMs) {
        sandboxLogger.info('sandbox.session_idle_timeout', {
          event: 'sandbox.session_idle_timeout',
          sessionId,
          workspaceId: session.workspaceId,
          containerId: session.containerId,
          idleMs,
        })
        void this.destroySession(sessionId)
      } else {
        this.scheduleIdleTimer(sessionId)
      }
    }, this.config.idleTimeoutMs)
    this.timers.set(sessionId, timer)
  }

  private refreshIdleTimer(sessionId: string) {
    this.scheduleIdleTimer(sessionId)
  }

  private clearIdleTimer(sessionId: string) {
    const timer = this.timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionId)
    }
  }
}

let defaultOrchestrator: SandboxOrchestrator | null = null

export function getSandboxOrchestrator(): SandboxOrchestrator {
  if (!defaultOrchestrator) defaultOrchestrator = new SandboxOrchestrator()
  return defaultOrchestrator
}

export { SandboxOrchestrator }
