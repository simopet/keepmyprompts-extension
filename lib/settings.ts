import { browser } from 'wxt/browser'
import type { SiteHost } from './sites'

export type { SiteHost }

/**
 * Everything the extension remembers, in chrome.storage.local (never a cookie, never the page).
 * `token` is the `kmp_live_...` extension key (scope `ext`); it is only ever read by the
 * background service worker, which is the single place that talks to the API. Content scripts
 * listen to storage changes only as a trigger to ask the worker for a fresh State; they never read
 * the settings object themselves.
 */
export interface Settings {
  apiBase: string
  token: string | null
  paused: boolean
  /** Per-site capture consent: undefined = not asked yet, true/false = the user's answer. */
  sites: Partial<Record<SiteHost, boolean>>
  locale: 'en' | 'it'
  /** Pre-send balloon reduced to the logo only (§ 1bis). */
  balloonCollapsed: boolean
  /** Where the user dragged the balloon (viewport px); null = follow the composer. */
  balloonPos: { x: number; y: number } | null
}

export const PROD_API_BASE = 'https://www.keepmyprompts.com'
export const DEFAULT_API_BASE = PROD_API_BASE
/** Servers a build may talk to. Development builds add the dev host and localhost; production knows one. */
export const ALLOWED_API_BASES: string[] = import.meta.env.DEV
  ? [PROD_API_BASE, 'https://dev.keepmyprompts.com', 'http://localhost:3999']
  : [PROD_API_BASE]

const KEY = 'settings'

export const DEFAULT_SETTINGS: Settings = {
  apiBase: DEFAULT_API_BASE,
  token: null,
  paused: false,
  sites: {},
  locale: 'en',
  balloonCollapsed: false,
  balloonPos: null,
}

export async function getSettings(): Promise<Settings> {
  const raw = await browser.storage.local.get(KEY)
  const stored = (raw[KEY] as Partial<Settings> | undefined) ?? {}
  const merged = { ...DEFAULT_SETTINGS, ...stored, sites: { ...(stored.sites ?? {}) } }
  // A production build ignores any non-production server left in storage by a development build.
  if (!ALLOWED_API_BASES.includes(merged.apiBase)) merged.apiBase = DEFAULT_API_BASE
  return merged
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next: Settings = { ...current, ...patch, sites: { ...current.sites, ...(patch.sites ?? {}) } }
  await browser.storage.local.set({ [KEY]: next })
  return next
}

export function detectLocale(): 'en' | 'it' {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en'
}
