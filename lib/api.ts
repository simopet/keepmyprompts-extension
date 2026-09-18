import { getSettings } from './settings'

/**
 * HTTP client for /api/ext/v1/*. Runs ONLY in the background service worker: it holds the token,
 * and host_permissions on keepmyprompts.com make the calls first-party (no CORS dance).
 * Server contract: docs/browser-extension-plan.md § 5.3 in the private repo.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiBase, token } = await getSettings()
  if (!token) throw new ApiError(401, 'not_connected')
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/ext/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `http_${res.status}`
    throw new ApiError(res.status, String(msg), body)
  }
  return body as T
}

export const api = {
  me: () => call<{ user: { id: string; email: string; name: string | null }; plan: string; prompts: { current: number; max: number | null }; quick_optimize: { daily_limit: number; used_today: number; remaining: number } }>('/me'),
  capture: (content: string, host: string, locale: string) =>
    call<Record<string, unknown>>('/capture', { method: 'POST', body: JSON.stringify({ content, host, locale }) }),
  score: (input: { prompt_id?: string; content?: string }, locale: string) =>
    call<{ success: boolean; rating?: unknown; cached?: boolean; error?: string }>('/score', { method: 'POST', body: JSON.stringify({ ...input, locale }) }),
  optimizeLight: (prompt_id: string, locale: string) =>
    call<{ success: boolean; data?: { variants: unknown[]; originalScore?: unknown; variantScore?: unknown }; remaining?: number; error?: string }>('/optimize-light', { method: 'POST', body: JSON.stringify({ prompt_id, locale }) }),
  saveVersion: (input: { prompt_id: string; content: string; apply: boolean; version_name?: string }) =>
    call<{ success: boolean; error?: string }>('/versions', { method: 'POST', body: JSON.stringify(input) }),
  track: (name: string, properties?: Record<string, unknown>) =>
    call<{ ok: boolean }>('/events', { method: 'POST', body: JSON.stringify({ name, properties }) }),
}
