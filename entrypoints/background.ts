import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { api, ApiError } from '../lib/api'
import { getSettings, updateSettings } from '../lib/settings'
import { SITE_LIST, type SiteConfig } from '../lib/sites'
import type { Request, Response, State } from '../lib/messages'

/**
 * The only place that talks to keepmyprompts.com. Content scripts and the popup send typed
 * messages; the token never leaves this worker.
 */
export default defineBackground(() => {
  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (r: Response) => void) => {
    handle(raw as Request)
      .then(sendResponse)
      .catch((err: unknown) => sendResponse(toError(err)))
    return true // async response
  })

  // Optional sites (lib/sites.ts): the content script runs only where the user granted the host.
  void syncOptionalSites()
  browser.permissions.onAdded.addListener(p => void syncOptionalSites(p.origins ?? []))
  browser.permissions.onRemoved.addListener(() => void syncOptionalSites())
})

function toError(err: unknown): Response {
  if (err instanceof ApiError) {
    const reset = (err.body as { resetInMinutes?: unknown } | null)?.resetInMinutes
    return { ok: false, status: err.status, error: err.message, ...(typeof reset === 'number' ? { resetInMinutes: reset } : {}) }
  }
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
}

/**
 * Registers the content script of every optional site whose host permission is granted, and
 * unregisters it where the permission was withdrawn (popup, or Chrome's own site-access menu).
 * Registrations persist across browser restarts; this runs at every worker start anyway, so the
 * registered set always follows the granted set.
 *
 * `justGranted` = origins from permissions.onAdded: those tabs are already open and a registration
 * only applies to future navigations, so the script is also injected into them now. Never on a
 * plain start, where open tabs may still run an instance (runChatSite guards against a second one).
 */
async function syncOptionalSites(justGranted: string[] = []) {
  for (const site of SITE_LIST.filter(s => s.optional && s.script)) {
    try {
      const granted = await browser.permissions.contains({ origins: site.matches })
      const registered = (await browser.scripting.getRegisteredContentScripts({ ids: [site.host] })).length > 0
      if (granted && !registered) {
        await browser.scripting.registerContentScripts([{
          id: site.host,
          js: [site.script as string],
          matches: site.matches,
          allFrames: site.allFrames ?? false,
          runAt: 'document_idle',
        }])
      } else if (!granted && registered) {
        await browser.scripting.unregisterContentScripts({ ids: [site.host] })
      }
      if (granted && site.matches.some(m => justGranted.includes(m))) await injectIntoOpenTabs(site)
    } catch (err) {
      console.warn(`[kmp] optional site ${site.host}:`, err)
    }
  }
}

async function injectIntoOpenTabs(site: SiteConfig) {
  const tabs = await browser.tabs.query({ url: site.matches })
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    await browser.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: site.allFrames ?? false }, files: [site.script!] })
      .catch(() => {}) // a tab that is loading or crashed: the registration covers its next load
  }
}

async function handle(msg: Request): Promise<Response> {
  const settings = await getSettings()
  const locale = settings.locale

  switch (msg.type) {
    case 'getState': {
      // The page knows the browser language; the worker only remembers it. Before this, the
      // locale was set only when connecting from the popup, so early adopters stayed on 'en'.
      if (msg.locale && msg.locale !== settings.locale) {
        await updateSettings({ locale: msg.locale })
        settings.locale = msg.locale
      }
      const state: State = {
        connected: Boolean(settings.token),
        paused: settings.paused,
        consent: settings.sites[msg.host],
        locale: settings.locale,
        apiBase: settings.apiBase,
        collapsed: settings.balloonCollapsed,
        balloonPos: settings.balloonPos,
      }
      return { ok: true, data: state }
    }
    case 'setConsent': {
      await updateSettings({ sites: { [msg.host]: msg.enabled } })
      void api.track('ext_capture_toggled', { host: msg.host, enabled: msg.enabled }).catch(() => {})
      return { ok: true, data: null }
    }
    case 'setBalloonPos': {
      await updateSettings({ balloonPos: msg.pos })
      return { ok: true, data: null }
    }
    case 'setCollapsed': {
      await updateSettings({ balloonCollapsed: msg.collapsed })
      void api.track('ext_balloon_collapsed', { collapsed: msg.collapsed }).catch(() => {})
      return { ok: true, data: null }
    }
    case 'capture': {
      if (!settings.token) return { ok: false, status: 401, error: 'not_connected' }
      // A manual «Salva» from the balloon is an explicit choice: it bypasses the per-site consent
      // that gates the silent capture (but never the global pause).
      if (settings.paused) return { ok: false, error: 'capture_disabled' }
      if (!msg.manual && settings.sites[msg.host] !== true) return { ok: false, error: 'capture_disabled' }
      const data = await api.capture(msg.content, msg.host, locale)
      const created = (data as { created?: boolean }).created
      if ((data as { at_limit?: boolean }).at_limit) void api.track('ext_at_limit_shown', { host: msg.host, manual: Boolean(msg.manual) }).catch(() => {})
      else if (msg.manual) void api.track('ext_draft_saved', { host: msg.host, created }).catch(() => {})
      else void api.track('ext_captured', { host: msg.host, created }).catch(() => {})
      return { ok: true, data }
    }
    case 'score': {
      const data = await api.score({ prompt_id: msg.prompt_id, content: msg.content }, locale)
      return { ok: true, data }
    }
    case 'optimize': {
      const draft = !msg.prompt_id
      void api.track(draft ? 'ext_draft_optimized' : 'ext_optimize_started').catch(() => {})
      const data = await api.optimizeLight(draft ? { content: msg.content } : { prompt_id: msg.prompt_id }, locale)
      return { ok: true, data }
    }
    case 'saveVersion': {
      const data = await api.saveVersion({ prompt_id: msg.prompt_id, content: msg.content, apply: msg.apply, version_name: msg.version_name })
      void api.track(msg.apply ? 'ext_variant_applied' : 'ext_variant_saved_as_version').catch(() => {})
      return { ok: true, data }
    }
    case 'track': {
      await api.track(msg.name, msg.properties).catch(() => {})
      return { ok: true, data: null }
    }
    case 'me': {
      const data = await api.me()
      return { ok: true, data }
    }
    default:
      return { ok: false, error: 'unknown_message' }
  }
}
