import { defineContentScript } from 'wxt/utils/define-content-script'
import { browser } from 'wxt/browser'
import type { CaptureResult, Rating, Request, Response, State, Variant } from '../lib/messages'
import { t, type Strings } from '../lib/strings'

/**
 * claude.ai content script (prototype: selectors hardcoded, see docs § 4.2 / § 7 in the private repo).
 *
 * Capture strategy — "read on intent, confirm on empty": when the user presses Enter (no Shift)
 * or clicks Send we read the composer text immediately, then 600 ms later check that the
 * composer emptied. Only then the text is treated as sent. This avoids capturing drafts that
 * were not sent and survives the composer clearing itself before any "sent" event we could hook.
 *
 * What gets captured (decision 6, 2026-09-18): most chat messages are conversational
 * follow-ups ("yes", "shorter", "and point 3?") that nobody will reuse, and saving them all turns
 * the library into a transcript. So a message is captured only when it looks like a prompt:
 *   - the FIRST message of a conversation (URL still /new) needs at least 20 words;
 *   - a follow-up (URL already /chat/<id>) needs at least 25, i.e. a genuinely new instruction.
 * Below the threshold nothing is saved and no badge appears; the skip is counted as an event so
 * the prototype gate can measure how much noise the filter removed.
 */

const HOST = 'claude.ai' as const

const COMPOSER_SELECTORS = [
  'div.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
  'fieldset [contenteditable="true"]',
  '[contenteditable="true"]',
]
const SEND_BUTTON_SELECTOR = 'button[aria-label*="send" i], button[aria-label*="invia" i], button[type="submit"]'
const CONFIRM_DELAY_MS = 600
const MIN_WORDS_FIRST_MESSAGE = 20
const MIN_WORDS_FOLLOW_UP = 25
const DUPLICATE_WINDOW_MS = 5000

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  runAt: 'document_idle',
  main() {
    void boot()
  },
})

// ---------- messaging ----------

function send<T>(msg: Request): Promise<Response<T>> {
  return browser.runtime.sendMessage(msg) as Promise<Response<T>>
}

// ---------- DOM helpers ----------

function findComposer(): HTMLElement | null {
  for (const sel of COMPOSER_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel)
    if (el && el.isContentEditable) return el
  }
  return null
}

function composerText(el: HTMLElement | null): string {
  return (el?.innerText ?? '').replace(/ /g, ' ').trim()
}

function replaceComposerText(text: string): boolean {
  const el = findComposer()
  if (!el) return false
  el.focus()
  document.execCommand('selectAll', false)
  const ok = document.execCommand('insertText', false, text)
  if (!ok) {
    // Fallback for editors that ignore execCommand: replace children with paragraphs.
    el.innerHTML = ''
    for (const line of text.split('\n')) {
      const p = document.createElement('p')
      p.textContent = line
      el.appendChild(p)
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
  }
  return true
}

// ---------- boot ----------

let strings: Strings = t('en')
let state: State | null = null
let ui: Ui | null = null
let lastCaptured = { text: '', at: 0 }

async function boot() {
  const res = await send<State>({ type: 'getState', host: HOST })
  if (!res.ok) return
  state = res.data
  strings = t(state.locale)
  ui = new Ui(strings)

  if (!state.connected) return // nothing to do until the popup has a token
  if (state.consent === undefined) {
    ui.showConsent(async enabled => {
      await send({ type: 'setConsent', host: HOST, enabled })
      state = { ...(state as State), consent: enabled }
      if (enabled) armCaptureListeners()
    })
    return
  }
  if (state.consent && !state.paused) armCaptureListeners()
}

function armCaptureListeners() {
  document.addEventListener(
    'keydown',
    e => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      const target = e.target as HTMLElement | null
      if (!target || !target.isContentEditable) return
      armCapture(composerText(target))
    },
    true
  )
  document.addEventListener(
    'click',
    e => {
      const btn = (e.target as Element | null)?.closest?.(SEND_BUTTON_SELECTOR)
      if (!btn) return
      armCapture(composerText(findComposer()))
    },
    true
  )
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** True while the URL is still /new (or the root): the message about to go is the conversation opener. */
function isNewConversation(): boolean {
  const p = location.pathname.replace(/\/+$/, '')
  return p === '' || p === '/new' || p.startsWith('/new/')
}

function armCapture(text: string) {
  if (!text) return
  const first = isNewConversation() // read BEFORE the send flips the URL to /chat/<id>
  const words = wordCount(text)
  const min = first ? MIN_WORDS_FIRST_MESSAGE : MIN_WORDS_FOLLOW_UP
  window.setTimeout(() => {
    const now = composerText(findComposer())
    if (now === text) return // not sent (validation, network, or the user changed their mind)
    if (text === lastCaptured.text && Date.now() - lastCaptured.at < DUPLICATE_WINDOW_MS) return
    lastCaptured = { text, at: Date.now() }
    if (words < min) {
      void send({ type: 'track', name: 'ext_capture_skipped', properties: { reason: first ? 'short_first' : 'short_follow_up', words } })
      return
    }
    void onSent(text)
  }, CONFIRM_DELAY_MS)
}

// ---------- the flow after a send ----------

async function onSent(text: string) {
  if (!ui) return
  ui.showScoring()
  const cap = await send<CaptureResult>({ type: 'capture', host: HOST, content: text })
  if (!cap.ok) {
    if (cap.error === 'capture_disabled') return ui.hide()
    if (cap.status === 401) return ui.showMessage(strings.notConnected)
    void send({ type: 'track', name: 'ext_capture_failed', properties: { reason: cap.error } })
    return ui.showMessage(strings.error)
  }

  const data = cap.data
  const promptId = 'prompt_id' in data ? data.prompt_id : null
  const atLimit = 'at_limit' in data && data.at_limit

  // Score: by id when saved, by text when the library is full (score stays free, § 5.5).
  const scoreRes = await send<{ success: boolean; rating?: Rating; error?: string }>(
    promptId ? { type: 'score', prompt_id: promptId } : { type: 'score', content: text }
  )
  const rating = scoreRes.ok && scoreRes.data.success ? scoreRes.data.rating ?? null : null

  ui.showScored({
    rating,
    promptId,
    atLimit: atLimit ? { max: (data as { max: number | null }).max ?? 20 } : null,
    reused: 'use_count' in data && data.use_count > 1 ? data.use_count : null,
    onOptimize: promptId ? () => optimize(promptId) : null,
  })
}

async function optimize(promptId: string) {
  if (!ui) return
  ui.showOptimizing()
  const res = await send<{ success: boolean; data?: { variants: Variant[] }; error?: string }>({ type: 'optimize', prompt_id: promptId })
  if (!res.ok) return ui.showMessage(res.status === 401 ? strings.notConnected : strings.error)
  const body = res.data
  if (!body.success) {
    if (body.error === 'alreadyOptimal') return ui.showMessage(strings.alreadyOptimal)
    if (body.error === 'dailyLimitReached') return ui.showMessage(strings.dailyLimit)
    return ui.showMessage(strings.error)
  }
  const variant = body.data?.variants?.[0]
  if (!variant) return ui.showMessage(strings.error)

  ui.showVariant(variant, {
    onReplace: async () => {
      // Replace = the web's "apply variant": the library prompt becomes the variant (current text
      // snapshotted as a version) AND the composer shows it. Sending it then dedups to the same
      // prompt instead of creating a second one.
      const saved = await send({ type: 'saveVersion', prompt_id: promptId, content: variant.content, apply: true })
      const replaced = replaceComposerText(variant.content)
      ui?.showMessage(saved.ok && replaced ? strings.applied : strings.error)
    },
    onSaveVersion: async () => {
      const saved = await send({ type: 'saveVersion', prompt_id: promptId, content: variant.content, apply: false, version_name: variant.strategyName ?? 'Quick Optimize' })
      ui?.showMessage(saved.ok ? strings.versionSaved : strings.error)
    },
  })
}

// ---------- UI (shadow DOM, fixed bottom-right) ----------

const CSS = `
:host { all: initial; }
.kmp { position: fixed; right: 20px; bottom: 96px; z-index: 2147483000; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; }
.badge { display: flex; align-items: center; gap: 8px; background: #fff; border: 1px solid #e2e8f0; border-radius: 999px; padding: 6px 12px 6px 6px; box-shadow: 0 6px 24px rgba(15,23,42,.12); cursor: pointer; }
.dot { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 13px; }
.panel { width: 340px; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 12px 40px rgba(15,23,42,.18); padding: 14px; }
.panel h3 { margin: 0 0 8px; font-size: 14px; }
.row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px dashed #f1f5f9; }
.tip { margin: 10px 0; padding: 8px 10px; background: #f8fafc; border-radius: 8px; color: #334155; }
.btn { display: inline-block; border: 0; border-radius: 10px; padding: 8px 12px; font-weight: 600; cursor: pointer; background: #0d9488; color: #fff; margin: 6px 6px 0 0; }
.btn.secondary { background: #f1f5f9; color: #0f172a; }
.btn.link { background: transparent; color: #0d9488; padding: 8px 4px; }
.muted { color: #64748b; font-size: 12px; }
textarea { width: 100%; min-height: 140px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; font: inherit; resize: vertical; box-sizing: border-box; }
.spin { width: 14px; height: 14px; border: 2px solid #cbd5e1; border-top-color: #0d9488; border-radius: 50%; animation: s .8s linear infinite; display: inline-block; vertical-align: -2px; margin-right: 6px; }
@keyframes s { to { transform: rotate(360deg) } }
`

function scoreColor(score: number): string {
  if (score >= 4) return '#16a34a'
  if (score >= 3) return '#ca8a04'
  return '#dc2626'
}

class Ui {
  private root: ShadowRoot
  private box: HTMLDivElement

  constructor(private s: Strings) {
    const host = document.createElement('div')
    host.setAttribute('data-kmp-ext', '')
    document.documentElement.appendChild(host)
    this.root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = CSS
    this.root.appendChild(style)
    this.box = document.createElement('div')
    this.box.className = 'kmp'
    this.root.appendChild(this.box)
    this.hide()
  }

  hide() {
    this.box.innerHTML = ''
    this.box.style.display = 'none'
  }

  private show(html: string) {
    this.box.innerHTML = html
    this.box.style.display = ''
  }

  private q<T extends Element>(sel: string): T | null {
    return this.box.querySelector<T>(sel)
  }

  showConsent(onAnswer: (enabled: boolean) => void) {
    this.show(`<div class="panel"><h3>${esc(this.s.consentTitle)}</h3><p>${esc(this.s.consentBody)}</p>
      <button class="btn" data-a="yes">${esc(this.s.consentYes)}</button>
      <button class="btn secondary" data-a="no">${esc(this.s.consentNo)}</button></div>`)
    this.q<HTMLButtonElement>('[data-a="yes"]')?.addEventListener('click', () => { onAnswer(true); this.hide() })
    this.q<HTMLButtonElement>('[data-a="no"]')?.addEventListener('click', () => { onAnswer(false); this.hide() })
  }

  showScoring() {
    this.show(`<div class="badge"><span class="spin"></span><span class="muted">${esc(this.s.scoring)}</span></div>`)
  }

  showOptimizing() {
    this.show(`<div class="badge"><span class="spin"></span><span class="muted">${esc(this.s.optimizing)}</span></div>`)
  }

  showMessage(text: string) {
    this.show(`<div class="panel"><p>${esc(text)}</p><button class="btn secondary" data-a="close">${esc(this.s.close)}</button></div>`)
    this.q('[data-a="close"]')?.addEventListener('click', () => this.hide())
  }

  showScored(opts: {
    rating: Rating | null
    promptId: string | null
    atLimit: { max: number } | null
    reused: number | null
    onOptimize: (() => void) | null
  }) {
    const overall = opts.rating ? Number(opts.rating.overallScore) : NaN
    const dot = Number.isFinite(overall)
      ? `<span class="dot" style="background:${scoreColor(overall)}">${overall.toFixed(1)}</span>`
      : `<span class="dot" style="background:#94a3b8">?</span>`
    const label = opts.atLimit ? this.s.atLimit(opts.atLimit.max) : opts.reused ? this.s.reused(opts.reused) : this.s.saved
    this.show(`<div class="badge" data-a="open">${dot}<span class="muted">${esc(label)}</span></div>`)
    this.q('[data-a="open"]')?.addEventListener('click', () => this.showDetail(opts, overall))
  }

  private showDetail(opts: Parameters<Ui['showScored']>[0], overall: number) {
    const rows = opts.rating
      ? Object.entries(opts.rating.scores)
          .map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`)
          .join('')
      : ''
    const tip = opts.rating?.tip ? `<div class="tip"><b>${esc(this.s.tip)}:</b> ${esc(opts.rating.tip)}</div>` : ''
    const limit = opts.atLimit
      ? `<div class="tip">${esc(this.s.atLimit(opts.atLimit.max))} <a class="btn link" href="${esc((state?.apiBase ?? '') + '/pricing')}" target="_blank" rel="noopener">${esc(this.s.upgrade)}</a></div>`
      : ''
    const improve = opts.onOptimize ? `<button class="btn" data-a="opt">${esc(this.s.improve)}</button>` : ''
    this.show(`<div class="panel"><h3>${esc(this.s.score)} ${Number.isFinite(overall) ? overall.toFixed(1) : ''}</h3>${rows}${tip}${limit}
      ${improve}<button class="btn secondary" data-a="close">${esc(this.s.close)}</button></div>`)
    this.q('[data-a="opt"]')?.addEventListener('click', () => opts.onOptimize?.())
    this.q('[data-a="close"]')?.addEventListener('click', () => this.hide())
  }

  showVariant(variant: Variant, actions: { onReplace: () => void; onSaveVersion: () => void }) {
    const score = typeof variant.promptScore === 'object' ? variant.promptScore?.overall : variant.promptScore
    this.show(`<div class="panel"><h3>${esc(this.s.variantTitle)} ${score != null ? `· ${esc(String(score))}` : ''}</h3>
      <textarea readonly>${esc(variant.content)}</textarea>
      <button class="btn" data-a="replace">${esc(this.s.replace)}</button>
      <button class="btn secondary" data-a="version">${esc(this.s.saveVersion)}</button>
      <button class="btn link" data-a="close">${esc(this.s.close)}</button></div>`)
    this.q('[data-a="replace"]')?.addEventListener('click', actions.onReplace)
    this.q('[data-a="version"]')?.addEventListener('click', actions.onSaveVersion)
    this.q('[data-a="close"]')?.addEventListener('click', () => this.hide())
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}
