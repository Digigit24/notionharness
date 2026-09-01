import config from '../../../../payload.config'
import { NextResponse } from 'next/server'
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes'

type PayloadRouteContext = { params: Promise<Record<string, string | string[]>> }
type PayloadRouteHandler = (request: Request, context: PayloadRouteContext) => Promise<Response> | Response

/** Payload's REST adapters normally serialize APIError instances themselves.
 * Keep the Next route boundary defensive: a rejected adapter promise must
 * become an HTTP response, never an unhandled rejection that can terminate
 * the server process. */
function safePayloadRoute(handler: PayloadRouteHandler): PayloadRouteHandler {
  return async (request, context) => {
    try {
      return await handler(request, context)
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status >= 400
          ? error.status
          : 500
      const message = error instanceof Error ? error.message : 'Payload request failed.'
      console.error('[payload-api] request failed', { status, message })
      return NextResponse.json({ errors: [{ message }] }, { status })
    }
  }
}

export const GET = safePayloadRoute(REST_GET(config) as PayloadRouteHandler)
export const POST = safePayloadRoute(REST_POST(config) as PayloadRouteHandler)
export const DELETE = safePayloadRoute(REST_DELETE(config) as PayloadRouteHandler)
export const PATCH = safePayloadRoute(REST_PATCH(config) as PayloadRouteHandler)
export const PUT = safePayloadRoute(REST_PUT(config) as PayloadRouteHandler)
export const OPTIONS = safePayloadRoute(REST_OPTIONS(config) as PayloadRouteHandler)
