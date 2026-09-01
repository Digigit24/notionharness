import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'

const HERMES_BASE_URL = process.env.HERMES_API_BASE_URL || 'https://digitech.tail7572d2.ts.net/v1'
const HERMES_API_KEY = process.env.HERMES_API_KEY || ''

export interface HermesProxyOptions extends RequestInit {
  hermesPath: string
  searchParams?: Record<string, string | string[] | undefined>
}

export async function proxyToHermes(options: HermesProxyOptions) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { hermesPath, searchParams, ...fetchOptions } = options

  const url = new URL(`${HERMES_BASE_URL}${hermesPath}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          for (const v of value) {
            url.searchParams.append(key, v)
          }
        } else {
          url.searchParams.set(key, value)
        }
      }
    }
  }

  const headers: HeadersInit = {
    'Authorization': `Bearer ${HERMES_API_KEY}`,
    'Content-Type': 'application/json',
    ...(fetchOptions.headers || {}),
  }

  const response = await fetch(url.toString(), {
    ...fetchOptions,
    headers,
  })

  const data = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    parsed = data
  }

  return NextResponse.json(parsed, { status: response.status })
}

export async function hermesGet(
  hermesPath: string,
  searchParams?: Record<string, string | string[] | undefined>
) {
  return proxyToHermes({ hermesPath, searchParams, method: 'GET' })
}

export async function hermesPost(
  hermesPath: string,
  body?: unknown,
  searchParams?: Record<string, string | string[] | undefined>
) {
  return proxyToHermes({
    hermesPath,
    searchParams,
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  })
}

export async function hermesPatch(
  hermesPath: string,
  body?: unknown
) {
  return proxyToHermes({
    hermesPath,
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined,
  })
}

export async function hermesDelete(
  hermesPath: string,
  body?: unknown
) {
  return proxyToHermes({
    hermesPath,
    method: 'DELETE',
    body: body ? JSON.stringify(body) : undefined,
  })
}
