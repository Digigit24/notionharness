import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { createPtyWebSocketServer } from '../lib/terminal/pty-server'

const marker = `notionforge-pty-${Date.now()}`
const server = createServer()
const ptyServer = createPtyWebSocketServer({ server, cols: 100, rows: 30 })

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Test server did not receive a TCP address')

try {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/terminal`)
  const output: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for PTY output')), 10_000)
    socket.once('error', reject)
    socket.on('message', data => {
      output.push(Buffer.from(data as Buffer))
      if (Buffer.concat(output).toString('utf8').includes(marker)) {
        clearTimeout(timeout)
        resolve()
      }
    })
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
      socket.send(`echo ${marker}\r`)
    })
  })
  socket.close()
  const text = Buffer.concat(output).toString('utf8')
  if (!text.includes(marker)) throw new Error('PTY output did not round-trip')
  console.log(`PTY smoke test passed: ${marker}`)
} finally {
  ptyServer.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
