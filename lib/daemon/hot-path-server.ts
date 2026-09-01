/** Separate LAN/browser hot path. Control-plane framing must never be sent here. */
import { WebSocket, WebSocketServer } from 'ws'

export interface HotPathServerOptions {
  port: number
  host?: string
  path?: string
}

export function createHotPathServer(options: HotPathServerOptions) {
  const server = new WebSocketServer({ port: options.port, host: options.host ?? '127.0.0.1', path: options.path ?? '/terminal-hot' })
  server.on('connection', socket => {
    socket.on('message', data => {
      for (const peer of server.clients) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(data)
      }
    })
  })
  return server
}
