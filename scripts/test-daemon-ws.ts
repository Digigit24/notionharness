import { WebSocket, WebSocketServer } from 'ws'
import { ControlChannel } from '../lib/daemon/control-channel'

const stub = new WebSocketServer({ port: 0, host: '127.0.0.1' })
await new Promise<void>(resolve => stub.on('listening', resolve))
const address = stub.address()
if (!address || typeof address === 'string') throw new Error('Stub did not bind')
let connections = 0
let sawEvent = false
let resolveReconnect: (() => void) | undefined
const reconnected = new Promise<void>(resolve => { resolveReconnect = resolve })
stub.on('connection', socket => {
  connections++
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as { type: string }
    if (message.type === 'register' && connections > 1) resolveReconnect?.()
    if (message.type === 'run_event') sawEvent = true
    socket.send(JSON.stringify({ type: 'ack', messageId: 'stub-ack' }))
  })
  if (connections === 1) setTimeout(() => socket.close(), 50)
})

const channel = new ControlChannel({
  url: `ws://127.0.0.1:${address.port}`,
  daemonId: 'stub-daemon',
  reconnectMinMs: 20,
  reconnectMaxMs: 100,
  heartbeatMs: 1_000,
})
channel.start()
await new Promise(resolve => setTimeout(resolve, 100))
channel.sendRunEvent({ runId: 'run-1', seq: 1, type: 'terminal.output', payload: { bytes: 'hello' } })
await Promise.race([reconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect timeout')), 2_000))])
if (!sawEvent) throw new Error('RunEvent was not framed and received')
channel.stop()
stub.close()
console.log('Daemon control-channel reconnect/framing smoke test passed')
