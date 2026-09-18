import { browser } from 'wxt/browser'

/**
 * Everything the extension remembers, in chrome.storage.local (never a cookie, never the page).
 * `token` is the `kmp_live_...` extension key (scope `ext`); it is only ever read by the
 * background service worker, which is the single place that talks to the API.
 */
export type SiteHost = 'claude.ai'

export interface Settings {
  apiBase: string
  token: string | null
  paused: boolean
  /** Per-site capture consent: undefined = not asked yet, true/false = the user's answer. */
  sites: Partial<Record<SiteHost, boolean>>
  locale: 'en' | 'it'
  /** Pre-send balloon reduced to the logo only (§ 1bis). */
  balloonCollapsed: boolean
}

export const DEFAULT_API_BASE = 'https://dev.keepmyprompts.com'

const KEY = 'settings'

export const DEFAULT_SETTINGS: Settings = {
  apiBase: DEFAULT_API_BASE,
  token: null,
  paused: false,
  sites: {},
  locale: 'en',
  balloonCollapsed: false,
}

export async function getSettings(): Promise<Settings> {
  const raw = await browser.storage.local.get(KEY)
  const stored = (raw[KEY] as Partial<Settings> | undefined) ?? {}
  return { ...DEFAULT_SETTINGS, ...stored, sites: { ...(stored.sites ?? {}) } }
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
