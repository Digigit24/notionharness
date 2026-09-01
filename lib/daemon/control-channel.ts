/** Outbound-only control-plane channel. Run events use JSON here; terminals use a separate raw-byte socket. */
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import type { RunEventEnvelope } from '../run-events'

export type ControlMessage =
  | { type: 'register'; daemonId: string; metadata?: Record<string, unknown> }
  | { type: 'heartbeat'; daemonId: string; at: string }
  | { type: 'run_event'; event: RunEventEnvelope }

export type ControlCommand =
  | { type: 'ack'; messageId?: string }
  | { type: 'run_command'; messageId: string; runId: string; command: string; payload?: Record<string, unknown> }

export interface ControlChannelOptions {
  url: string
  daemonId: string
  metadata?: Record<string, unknown>
  reconnectMinMs?: number
  reconnectMaxMs?: number
  heartbeatMs?: number
  WebSocketImpl?: typeof WebSocket
}

export interface ControlChannelEvents {
  command: (command: ControlCommand) => void
  state: (state: 'connecting' | 'open' | 'closed' | 'stopped') => void
  error: (error: Error) => void
}

export class ControlChannel extends EventEmitter {
  private socket: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private stopped = true
  private reconnectMs: number
  private readonly options: Required<Pick<ControlChannelOptions, 'reconnectMinMs' | 'reconnectMaxMs' | 'heartbeatMs'>>

  constructor(private readonly config: ControlChannelOptions) {
    super()
    this.reconnectMs = config.reconnectMinMs ?? 500
    this.options = {
      reconnectMinMs: config.reconnectMinMs ?? 500,
      reconnectMaxMs: config.reconnectMaxMs ?? 30_000,
      heartbeatMs: config.heartbeatMs ?? 15_000,
    }
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    this.clearTimers()
    this.socket?.close(1000, 'daemon stopped')
    this.socket = null
    this.emit('state', 'stopped')
  }

  sendRunEvent(event: RunEventEnvelope): boolean {
    return this.send({ type: 'run_event', event })
  }

  send(message: ControlMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private connect() {
    if (this.stopped) return
    this.emit('state', 'connecting')
    const Socket = this.config.WebSocketImpl ?? WebSocket
    const socket = new Socket(this.config.url)
    this.socket = socket
    socket.on('open', () => {
      if (socket !== this.socket) return
      this.reconnectMs = this.options.reconnectMinMs
      this.emit('state', 'open')
      this.send({ type: 'register', daemonId: this.config.daemonId, metadata: this.config.metadata })
      this.heartbeatTimer = setInterval(() => {
        this.send({ type: 'heartbeat', daemonId: this.config.daemonId, at: new Date().toISOString() })
      }, this.options.heartbeatMs)
    })
    socket.on('message', data => {
      try {
        const command = JSON.parse(data.toString()) as ControlCommand
        if (command.type === 'ack' || command.type === 'run_command') this.emit('command', command)
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', error => this.emit('error', error instanceof Error ? error : new Error(String(error))))
    socket.on('close', () => {
      if (socket !== this.socket || this.stopped) return
      this.socket = null
      this.clearTimers()
      this.emit('state', 'closed')
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs)
      this.reconnectMs = Math.min(this.reconnectMs * 2, this.options.reconnectMaxMs)
    })
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.reconnectTimer = null
    this.heartbeatTimer = null
  }
}
