import { browser } from 'wxt/browser'
import { ALLOWED_API_BASES, DEFAULT_API_BASE, detectLocale, getSettings, updateSettings } from '../../lib/settings'
import { SITE_LIST, type SiteConfig } from '../../lib/sites'
import type { Request, Response } from '../../lib/messages'

type Me = { user: { email: string; name: string | null }; plan: string; prompts: { current: number; max: number | null }; quick_optimize: { daily_limit: number; used_today: number; remaining: number } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function send<T>(msg: Request): Promise<Response<T>> {
  return browser.runtime.sendMessage(msg) as Promise<Response<T>>
}

async function refresh() {
  const s = await getSettings()
  // The server picker exists only in development builds; production talks to one server.
  $('server-row').hidden = !import.meta.env.DEV
  $<HTMLSelectElement>('apiBase').value = s.apiBase || DEFAULT_API_BASE
  $<HTMLInputElement>('paused').checked = s.paused
  await renderSites(s.sites)
  $<HTMLAnchorElement>('library').href = `${s.apiBase}/dashboard`

  const connected = Boolean(s.token)
  $('connect').hidden = connected
  $('account').hidden = !connected
  if (!connected) return

  const me = await send<Me>({ type: 'me' })
  if (!me.ok) {
    $('who').textContent = me.status === 401 ? 'Key rejected. Disconnect and paste a new one.' : `Cannot reach the server (${me.error}).`
    $('limits').textContent = ''
    return
  }
  const d = me.data
  $('who').textContent = `${d.user.name ?? d.user.email} · ${d.plan}`
  const max = d.prompts.max === null ? '∞' : String(d.prompts.max)
  $('limits').textContent = `Prompts ${d.prompts.current}/${max} · Quick Optimize today ${d.quick_optimize.used_today}/${d.quick_optimize.daily_limit}`
}

$('save').addEventListener('click', async () => {
  const token = $<HTMLInputElement>('token').value.trim()
  const picked = $<HTMLSelectElement>('apiBase').value
  const apiBase = ALLOWED_API_BASES.includes(picked) ? picked : DEFAULT_API_BASE
  if (!token.startsWith('kmp_live_')) {
    $('status').textContent = 'That does not look like a KMP key (kmp_live_…).'
    return
  }
  await updateSettings({ token, apiBase, locale: detectLocale() })
  const me = await send<Me>({ type: 'me' })
  if (!me.ok) {
    await updateSettings({ token: null })
    $('status').textContent = me.status === 401 ? 'Key rejected by the server.' : `Cannot reach ${apiBase} (${me.error}).`
    return
  }
  $<HTMLInputElement>('token').value = ''
  void send({ type: 'track', name: 'ext_connected' })
  await refresh()
})

$('paused').addEventListener('change', async e => {
  await updateSettings({ paused: (e.target as HTMLInputElement).checked })
})
/**
 * One «Capture on …» toggle per site in lib/sites.ts. For an optional site (ChatGPT) the toggle is
 * also where Chrome's permission is asked: `permissions.request` must run inside the click, so the
 * granted state is read beforehand, at render time, and never awaited in the handler before it.
 * Once granted, the worker registers the content script (permissions.onAdded) and injects it into
 * the site's open tabs. Unchecking only withdraws capture consent: the permission stays, and with
 * it the balloon's manual buttons, exactly like a manifest site the user said «not here» to.
 */
async function renderSites(consent: Partial<Record<SiteConfig['host'], boolean>>) {
  const box = $('sites')
  box.textContent = ''
  for (const site of SITE_LIST) {
    const granted = site.optional ? await browser.permissions.contains({ origins: site.matches }) : true
    const label = document.createElement('label')
    label.className = 'toggle'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = granted && consent[site.host] === true
    label.append(input, ` Capture on ${site.label}`)
    if (!granted) {
      const hint = document.createElement('span')
      hint.className = 'muted'
      hint.textContent = '(Chrome will ask for access)'
      label.append(' ', hint)
    }
    input.addEventListener('change', () => {
      if (!input.checked) {
        void send({ type: 'setConsent', host: site.host, enabled: false })
        return
      }
      if (granted) {
        void send({ type: 'setConsent', host: site.host, enabled: true })
        return
      }
      browser.permissions.request({ origins: site.matches }).then(
        async ok => {
          if (!ok) { input.checked = false; return }
          await send({ type: 'setConsent', host: site.host, enabled: true })
          await refresh()
        },
        () => { input.checked = false }
      )
    })
    box.append(label)
  }
}
$('disconnect').addEventListener('click', async () => {
  await updateSettings({ token: null })
  await refresh()
})

void refresh()
