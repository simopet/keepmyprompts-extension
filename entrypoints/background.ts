import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { api, ApiError } from '../lib/api'
import { getSettings, updateSettings } from '../lib/settings'
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
})

function toError(err: unknown): Response {
  if (err instanceof ApiError) return { ok: false, status: err.status, error: err.message }
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
}

async function handle(msg: Request): Promise<Response> {
  const settings = await getSettings()
  const locale = settings.locale

  switch (msg.type) {
    case 'getState': {
      const state: State = {
        connected: Boolean(settings.token),
        paused: settings.paused,
        consent: settings.sites[msg.host],
        locale,
        apiBase: settings.apiBase,
      }
      return { ok: true, data: state }
    }
    case 'setConsent': {
      await updateSettings({ sites: { [msg.host]: msg.enabled } })
      void api.track('ext_capture_toggled', { host: msg.host, enabled: msg.enabled }).catch(() => {})
      return { ok: true, data: null }
    }
    case 'capture': {
      if (!settings.token) return { ok: false, status: 401, error: 'not_connected' }
      if (settings.paused || settings.sites[msg.host] !== true) return { ok: false, error: 'capture_disabled' }
      const data = await api.capture(msg.content, msg.host, locale)
      if ((data as { at_limit?: boolean }).at_limit) void api.track('ext_at_limit_shown', { host: msg.host }).catch(() => {})
      else void api.track('ext_captured', { host: msg.host, created: (data as { created?: boolean }).created }).catch(() => {})
      return { ok: true, data }
    }
    case 'score': {
      const data = await api.score({ prompt_id: msg.prompt_id, content: msg.content }, locale)
      return { ok: true, data }
    }
    case 'optimize': {
      void api.track('ext_optimize_started').catch(() => {})
      const data = await api.optimizeLight(msg.prompt_id, locale)
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
