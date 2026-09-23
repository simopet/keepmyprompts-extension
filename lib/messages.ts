/**
 * The contract between content scripts / popup (senders) and the background worker (the only
 * caller of the KMP API). Kept as plain discriminated unions so both sides type-check together.
 */
import type { SiteHost } from './settings'

export type Rating = {
  scores: Record<string, number>
  overallScore: string | number
  tip: string | null
  promptType: string
}

export type Variant = {
  index: number
  content: string
  strategy: string
  strategyName?: string
  changes?: string[]
  promptScore?: { overall?: number; tip?: string | null; [criterion: string]: unknown } | number
}

export type CaptureResult =
  | { prompt_id: string; created: boolean; use_count: number; title?: string }
  | { created: false; at_limit: true; current: number; max: number | null }

export type Request =
  | { type: 'getState'; host: SiteHost; locale?: 'en' | 'it' }
  | { type: 'setConsent'; host: SiteHost; enabled: boolean }
  | { type: 'capture'; host: SiteHost; content: string; manual?: boolean }
  | { type: 'score'; prompt_id?: string; content?: string }
  | { type: 'optimize'; prompt_id?: string; content?: string }
  | { type: 'setCollapsed'; collapsed: boolean }
  | { type: 'setBalloonPos'; pos: { x: number; y: number } | null }
  | { type: 'saveVersion'; prompt_id: string; content: string; apply: boolean; version_name?: string }
  | { type: 'track'; name: string; properties?: Record<string, unknown> }
  | { type: 'me' }

/** `resetInMinutes` travels with 429s (scoring and capture quotas) so the page can say when to retry. */
export type Response<T = unknown> = { ok: true; data: T } | { ok: false; status?: number; error: string; resetInMinutes?: number }

export type State = {
  connected: boolean
  paused: boolean
  consent: boolean | undefined
  locale: 'en' | 'it'
  apiBase: string
  collapsed: boolean
  balloonPos: { x: number; y: number } | null
}
