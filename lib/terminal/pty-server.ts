/**
 * Dedicated terminal transport boundary.
 *
 * This socket intentionally carries terminal bytes only; run/control events
 * belong on a separate protocol. PTY output is sent as binary WebSocket
 * frames. Client input is written as binary frames (or text for compatibility
 * with xterm.js clients), while resize is the sole JSON control message:
 * `{ "type": "resize", "cols": number, "rows": number }`.
 *
 * Authentication and mapping a connection to a sandbox session are daemon
 * responsibilities. The `cwd` option is the integration point for that
 * future routing layer and can point at SandboxSession.workspacePath today.
 */
import type { Server } from 'node:http'
import process from 'node:process'
import * as pty from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'

export interface PtyServerOptions {
  server: Server
  path?: string
  shell?: string
  shellArgs?: string[]
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string | undefined>
}

export interface PtyResizeMessage {
  type: 'resize'
  cols: number
  rows: number
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

function defaultShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') return { shell: process.env.ComSpec ?? 'cmd.exe', args: [] }
  return { shell: process.env.SHELL ?? '/bin/sh', args: ['-l'] }
}

function isResizeMessage(value: unknown): value is PtyResizeMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<PtyResizeMessage>
  return message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0
}

function sendBytes(socket: WebSocket, value: string) {
  if (socket.readyState === WebSocket.OPEN) socket.send(Buffer.from(value, 'utf8'))
}

export function createPtyWebSocketServer(options: PtyServerOptions): WebSocketServer {
  const defaults = defaultShell()
  const sockets = new Set<WebSocket>()
  const wss = new WebSocketServer({ server: options.server, path: options.path ?? '/terminal' })

  wss.on('connection', (socket: WebSocket) => {
    sockets.add(socket)
    const cwd = options.cwd
    const env = { ...process.env, ...options.env, TERM: options.env?.TERM ?? 'xterm-256color' } as Record<string, string>
    const terminal = pty.spawn(options.shell ?? defaults.shell, options.shellArgs ?? defaults.args, {
      name: 'xterm-256color',
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      cwd,
      env,
    })
    let closed = false

    const cleanup = () => {
      if (closed) return
      closed = true
      sockets.delete(socket)
      terminal.kill()
    }

    terminal.onData(data => {
      if (socket.readyState === WebSocket.OPEN) socket.send(Buffer.from(data, 'utf8'))
    })
    terminal.onExit(({ exitCode }) => {
      if (socket.readyState === WebSocket.OPEN) {
        sendBytes(socket, `\r\n[process exited with code ${exitCode}]\r\n`)
        socket.close(1000, 'terminal exited')
      }
      closed = true
      sockets.delete(socket)
    })
    socket.on('message', (data, isBinary) => {
      if (closed) return
      if (isBinary) {
        terminal.write(data.toString())
        return
      }
      const text = data.toString()
      try {
        const control: unknown = JSON.parse(text)
        if (isResizeMessage(control)) {
          terminal.resize(control.cols, control.rows)
          return
        }
      } catch {
        // Plain text is terminal input, not a malformed control frame.
      }
      terminal.write(text)
    })
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  wss.on('close', () => {
    for (const socket of sockets) socket.close(1001, 'terminal server closed')
    sockets.clear()
  })
  return wss
}
