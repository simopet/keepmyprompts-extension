import { browser } from 'wxt/browser'
import { DEFAULT_API_BASE, detectLocale, getSettings, updateSettings } from '../../lib/settings'
import type { Request, Response } from '../../lib/messages'

type Me = { user: { email: string; name: string | null }; plan: string; prompts: { current: number; max: number | null }; quick_optimize: { daily_limit: number; used_today: number; remaining: number } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function send<T>(msg: Request): Promise<Response<T>> {
  return browser.runtime.sendMessage(msg) as Promise<Response<T>>
}

async function refresh() {
  const s = await getSettings()
  $<HTMLSelectElement>('apiBase').value = s.apiBase || DEFAULT_API_BASE
  $<HTMLInputElement>('paused').checked = s.paused
  $<HTMLInputElement>('site-claude').checked = s.sites['claude.ai'] === true
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
  const apiBase = $<HTMLSelectElement>('apiBase').value
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
$('site-claude').addEventListener('change', async e => {
  await send({ type: 'setConsent', host: 'claude.ai', enabled: (e.target as HTMLInputElement).checked })
})
$('disconnect').addEventListener('click', async () => {
  await updateSettings({ token: null })
  await refresh()
})

void refresh()
