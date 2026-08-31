import { getPayload, type Payload } from 'payload'
import config from '@/payload.config'

// Note: `global._payload` is used internally by the `payload` package itself
// (a Map cache) — a different name is required here to avoid clobbering it.
declare global {
  var _notionforgePayloadClient: Promise<Payload> | undefined
}

export function getPayloadClient(): Promise<Payload> {
  if (!global._notionforgePayloadClient) {
    global._notionforgePayloadClient = getPayload({ config })
  }
  return global._notionforgePayloadClient
}
