import { defineContentScript } from 'wxt/utils/define-content-script'
import { browser } from 'wxt/browser'
import type { CaptureResult, Rating, Request, Response, State, Variant } from '../lib/messages'
import { t, type Strings } from '../lib/strings'

/**
 * claude.ai content script (prototype: selectors hardcoded, see docs § 4.2 / § 7 in the private repo).
 *
 * Two flows live here (plan § 1 and § 1bis):
 *
 * 1. SILENT CAPTURE, after a send — "read on intent, confirm on empty": when the user presses
 *    Enter (no Shift) or clicks Send we read the composer text immediately, then 600 ms later
 *    check that the composer emptied. Only then the text is treated as sent. A message is captured
 *    only when it looks like a prompt (decision 6): the FIRST message of a conversation (URL still
 *    /new) needs at least 20 words, a follow-up at least 25. Skips are counted as events.
 *
 * 2. PRE-SEND BALLOON (decision 7) — a compact pill anchored to the composer, always visible,
 *    with «Score prompt» and «Save to library»; «Optimize» unlocks after the score. Everything
 *    pre-send works on the composer text and writes NOTHING to the library until the user saves
 *    or sends: «Replace in composer» is a local action, the send then captures the final text.
 *    The manual buttons bypass the word thresholds (the user chose) but need 10 words, the
 *    minimum Quick Optimize accepts.
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
const MIN_WORDS_MANUAL = 10
const DUPLICATE_WINDOW_MS = 5000
const ALREADY_GOOD_SCORE = 4.5

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

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
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

/** True while the URL is still /new (or the root): the message about to go is the conversation opener. */
function isNewConversation(): boolean {
  const p = location.pathname.replace(/\/+$/, '')
  return p === '' || p === '/new' || p.startsWith('/new/')
}

// ---------- boot ----------

let strings: Strings = t('en')
let state: State | null = null
let ui: Ui | null = null
let balloon: Balloon | null = null
let lastCaptured = { text: '', at: 0 }
/** The last composer text scored from the balloon, reused by the post-send badge when identical. */
let draft: { text: string; rating: Rating | null } = { text: '', rating: null }

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
      mountBalloon()
    })
    return
  }
  if (state.consent && !state.paused) armCaptureListeners()
  if (!state.paused) mountBalloon()
}

function mountBalloon() {
  if (balloon || !state) return
  balloon = new Balloon(strings, state.collapsed)
}

// ---------- flow 1: silent capture after a send ----------

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

  // If the balloon already scored exactly this text, reuse it instead of paying a second call.
  let rating: Rating | null = null
  if (draft.rating && draft.text === text) {
    rating = draft.rating
  } else {
    const scoreRes = await send<{ success: boolean; rating?: Rating; error?: string }>(
      promptId ? { type: 'score', prompt_id: promptId } : { type: 'score', content: text }
    )
    rating = scoreRes.ok && scoreRes.data.success ? scoreRes.data.rating ?? null : null
  }

  ui.showScored({
    rating,
    promptId,
    atLimit: atLimit ? { max: (data as { max: number | null }).max ?? 20 } : null,
    reused: 'use_count' in data && data.use_count > 1 ? data.use_count : null,
    onOptimize: promptId ? () => optimizeSaved(promptId) : null,
  })
}

async function optimizeSaved(promptId: string) {
  if (!ui) return
  ui.showOptimizing()
  const res = await send<OptimizeBody>({ type: 'optimize', prompt_id: promptId })
  const variant = unwrapVariant(res)
  if (typeof variant === 'string') return ui.showMessage(variant)

  ui.showVariant(variant, {
    primary: {
      label: strings.replace,
      run: async () => {
        // Replace = the web's "apply variant": the library prompt becomes the variant (current text
        // snapshotted as a version) AND the composer shows it. Sending it then dedups to the same prompt.
        const saved = await send({ type: 'saveVersion', prompt_id: promptId, content: variant.content, apply: true })
        const replaced = replaceComposerText(variant.content)
        ui?.showMessage(saved.ok && replaced ? strings.applied : strings.error)
      },
    },
    secondary: {
      label: strings.saveVersion,
      run: async () => {
        const saved = await send({ type: 'saveVersion', prompt_id: promptId, content: variant.content, apply: false, version_name: variant.strategyName ?? 'Quick Optimize' })
        ui?.showMessage(saved.ok ? strings.versionSaved : strings.error)
      },
    },
  })
}

// ---------- flow 2: the pre-send balloon ----------

type OptimizeBody = { success: boolean; data?: { variants: Variant[] }; remaining?: number; error?: string }

/** Turns an optimize response into a variant, or into the message to show instead. */
function unwrapVariant(res: Response<OptimizeBody>): Variant | string {
  if (!res.ok) return res.status === 401 ? strings.notConnected : strings.error
  const body = res.data
  if (!body.success) {
    if (body.error === 'alreadyOptimal') return strings.alreadyOptimal
    if (body.error === 'dailyLimitReached') return strings.dailyLimit
    return strings.error
  }
  return body.data?.variants?.[0] ?? strings.error
}

async function scoreDraft(text: string) {
  if (!balloon || !ui) return
  balloon.setBusy(strings.scoring)
  const res = await send<{ success: boolean; rating?: Rating; error?: string }>({ type: 'score', content: text })
  balloon.setBusy(null)
  const rating = res.ok && res.data.success ? res.data.rating ?? null : null
  if (!rating) {
    return ui.showMessage(!res.ok && res.status === 401 ? strings.notConnected : strings.error)
  }
  draft = { text, rating }
  void send({ type: 'track', name: 'ext_draft_scored', properties: { score: Number(rating.overallScore), host: HOST } })
  balloon.render()
}

async function optimizeDraft(text: string) {
  if (!balloon || !ui) return
  balloon.setBusy(strings.optimizing)
  const res = await send<OptimizeBody>({ type: 'optimize', content: text })
  balloon.setBusy(null)
  const variant = unwrapVariant(res)
  if (typeof variant === 'string') return ui.showMessage(variant)
  const remaining = res.ok ? res.data.remaining : undefined

  ui.showVariant(variant, {
    note: typeof remaining === 'number' ? strings.remainingQuick(remaining) : undefined,
    primary: {
      label: strings.replace,
      run: () => {
        // Pre-send: local only. Nothing is written until the user saves or sends.
        const replaced = replaceComposerText(variant.content)
        ui?.showMessage(replaced ? strings.replacedLocal : strings.error)
        draft = { text: '', rating: null }
        balloon?.render()
      },
    },
    secondary: {
      label: strings.saveToLibrary,
      run: () => saveDraft(variant.content),
    },
  })
}

async function saveDraft(text: string) {
  if (!balloon || !ui) return
  balloon.setBusy(strings.saving)
  const cap = await send<CaptureResult>({ type: 'capture', host: HOST, content: text, manual: true })
  balloon.setBusy(null)
  if (!cap.ok) {
    return ui.showMessage(cap.status === 401 ? strings.notConnected : strings.error)
  }
  if ('at_limit' in cap.data && cap.data.at_limit) {
    return ui.showAtLimit(cap.data.max ?? 20)
  }
  balloon.flash(strings.saved)
}

// ---------- UI: shared styles ----------

const LOGO_SVG = `<svg viewBox="0 0 512 512" width="22" height="22" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop stop-color="#6366F1"/><stop offset="1" stop-color="#2DD4BF"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><path d="M120 158 L290 256 L120 354" stroke="#fff" stroke-width="56" stroke-linecap="round" stroke-linejoin="round" fill="none"/><rect x="325" y="212" width="44" height="88" rx="12" fill="#FBBF24"/></svg>`

const CSS = `
:host { all: initial; }
.kmp, .pill { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; }
.kmp { position: fixed; right: 20px; bottom: 96px; z-index: 2147483000; }
.badge { display: flex; align-items: center; gap: 8px; background: #fff; border: 1px solid #e2e8f0; border-radius: 999px; padding: 6px 12px 6px 6px; box-shadow: 0 6px 24px rgba(15,23,42,.12); cursor: pointer; }
.dot { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 13px; flex: none; }
.dot.sm { width: 24px; height: 24px; font-size: 12px; cursor: pointer; }
.panel { width: 340px; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 12px 40px rgba(15,23,42,.18); padding: 14px; }
.panel h3 { margin: 0 0 8px; font-size: 14px; }
.row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px dashed #f1f5f9; }
.tip { margin: 10px 0; padding: 8px 10px; background: #f8fafc; border-radius: 8px; color: #334155; }
.btn { display: inline-block; border: 0; border-radius: 10px; padding: 8px 12px; font-weight: 600; cursor: pointer; background: #0d9488; color: #fff; margin: 6px 6px 0 0; }
.btn.secondary { background: #f1f5f9; color: #0f172a; }
.btn.link { background: transparent; color: #0d9488; padding: 8px 4px; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.muted { color: #64748b; font-size: 12px; }
textarea { width: 100%; min-height: 140px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; font: inherit; resize: vertical; box-sizing: border-box; }
.spin { width: 14px; height: 14px; border: 2px solid #cbd5e1; border-top-color: #0d9488; border-radius: 50%; animation: s .8s linear infinite; display: inline-block; vertical-align: -2px; margin-right: 6px; flex: none; }
@keyframes s { to { transform: rotate(360deg) } }
/* pre-send balloon */
.pill { position: fixed; z-index: 2147483000; display: flex; align-items: center; gap: 6px; background: #fff; border: 1px solid #e2e8f0; border-radius: 999px; padding: 4px 6px; box-shadow: 0 4px 18px rgba(15,23,42,.14); white-space: nowrap; }
.pill .logo { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; cursor: pointer; flex: none; }
.pill .logo svg { border-radius: 6px; }
.pbtn { border: 0; border-radius: 999px; padding: 5px 10px; font: inherit; font-weight: 600; font-size: 12px; cursor: pointer; background: #f1f5f9; color: #0f172a; }
.pbtn.primary { background: #0d9488; color: #fff; }
.pbtn:disabled { opacity: .45; cursor: not-allowed; }
.pill .x { border: 0; background: transparent; color: #94a3b8; cursor: pointer; font-size: 14px; padding: 0 4px; }
.flash { color: #0d9488; font-weight: 600; font-size: 12px; padding: 0 6px; }
`

function scoreColor(score: number): string {
  if (score >= 4) return '#16a34a'
  if (score >= 3) return '#ca8a04'
  return '#dc2626'
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function makeShadowHost(): { root: ShadowRoot; box: HTMLDivElement } {
  const host = document.createElement('div')
  host.setAttribute('data-kmp-ext', '')
  document.documentElement.appendChild(host)
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = CSS
  root.appendChild(style)
  const box = document.createElement('div')
  root.appendChild(box)
  return { root, box }
}

// ---------- UI: post-send badge and panels (bottom-right) ----------

type VariantActions = {
  primary: { label: string; run: () => void | Promise<void> }
  secondary: { label: string; run: () => void | Promise<void> }
  note?: string
}

class Ui {
  private box: HTMLDivElement

  constructor(private s: Strings) {
    this.box = makeShadowHost().box
    this.box.className = 'kmp'
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

  showAtLimit(max: number) {
    this.show(`<div class="panel"><p>${esc(this.s.atLimit(max))}</p>
      <a class="btn" href="${esc((state?.apiBase ?? '') + '/pricing')}" target="_blank" rel="noopener">${esc(this.s.upgrade)}</a>
      <button class="btn secondary" data-a="close">${esc(this.s.close)}</button></div>`)
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
    this.q('[data-a="open"]')?.addEventListener('click', () => this.showDetail(opts.rating, opts.atLimit, opts.onOptimize))
  }

  /** Criteria + tip panel; used by the post-send badge and by the balloon's score dot. */
  showDetail(rating: Rating | null, atLimit: { max: number } | null, onOptimize: (() => void) | null) {
    const overall = rating ? Number(rating.overallScore) : NaN
    const rows = rating
      ? Object.entries(rating.scores)
          .map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`)
          .join('')
      : ''
    const tip = rating?.tip ? `<div class="tip"><b>${esc(this.s.tip)}:</b> ${esc(rating.tip)}</div>` : ''
    const limit = atLimit
      ? `<div class="tip">${esc(this.s.atLimit(atLimit.max))} <a class="btn link" href="${esc((state?.apiBase ?? '') + '/pricing')}" target="_blank" rel="noopener">${esc(this.s.upgrade)}</a></div>`
      : ''
    const improve = onOptimize ? `<button class="btn" data-a="opt">${esc(this.s.improve)}</button>` : ''
    this.show(`<div class="panel"><h3>${esc(this.s.score)} ${Number.isFinite(overall) ? overall.toFixed(1) : ''}</h3>${rows}${tip}${limit}
      ${improve}<button class="btn secondary" data-a="close">${esc(this.s.close)}</button></div>`)
    this.q('[data-a="opt"]')?.addEventListener('click', () => { this.hide(); onOptimize?.() })
    this.q('[data-a="close"]')?.addEventListener('click', () => this.hide())
  }

  showVariant(variant: Variant, actions: VariantActions) {
    const score = typeof variant.promptScore === 'object' ? variant.promptScore?.overall : variant.promptScore
    const note = actions.note ? `<p class="muted">${esc(actions.note)}</p>` : ''
    this.show(`<div class="panel"><h3>${esc(this.s.variantTitle)} ${score != null ? `· ${esc(String(score))}` : ''}</h3>
      <textarea readonly>${esc(variant.content)}</textarea>${note}
      <button class="btn" data-a="primary">${esc(actions.primary.label)}</button>
      <button class="btn secondary" data-a="secondary">${esc(actions.secondary.label)}</button>
      <button class="btn link" data-a="close">${esc(this.s.close)}</button></div>`)
    this.q('[data-a="primary"]')?.addEventListener('click', () => void actions.primary.run())
    this.q('[data-a="secondary"]')?.addEventListener('click', () => void actions.secondary.run())
    this.q('[data-a="close"]')?.addEventListener('click', () => this.hide())
  }
}

// ---------- UI: the pre-send balloon (anchored to the composer) ----------

class Balloon {
  private box: HTMLDivElement
  private busy: string | null = null
  private flashText: string | null = null
  private flashTimer: number | undefined
  private text = ''

  constructor(private s: Strings, private collapsed: boolean) {
    this.box = makeShadowHost().box
    this.box.className = 'pill'
    this.box.style.display = 'none'
    this.render()
    // Re-anchor cheaply: Claude re-renders its composer often, and a rAF loop would be overkill.
    window.setInterval(() => this.tick(), 250)
    window.addEventListener('resize', () => this.anchor())
    window.addEventListener('scroll', () => this.anchor(), true)
  }

  /** Follows the composer text; when it changes, a previous draft score no longer applies. */
  private tick() {
    const now = composerText(findComposer())
    if (now !== this.text) {
      this.text = now
      this.render()
    }
    this.anchor()
  }

  private anchor() {
    const composer = findComposer()
    const anchorEl = composer?.closest<HTMLElement>('fieldset') ?? composer?.closest<HTMLElement>('form') ?? composer
    const rect = anchorEl?.getBoundingClientRect()
    if (!rect || rect.width === 0) {
      this.box.style.display = 'none'
      return
    }
    this.box.style.display = ''
    const w = this.box.offsetWidth
    const h = this.box.offsetHeight
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.right - w))
    const top = Math.max(8, rect.top - h - 6)
    this.box.style.left = `${left}px`
    this.box.style.top = `${top}px`
  }

  setBusy(label: string | null) {
    this.busy = label
    this.render()
  }

  flash(text: string) {
    this.flashText = text
    this.render()
    window.clearTimeout(this.flashTimer)
    this.flashTimer = window.setTimeout(() => { this.flashText = null; this.render() }, 2500)
  }

  render() {
    const words = wordCount(this.text)
    const scored = draft.rating && draft.text === this.text ? draft.rating : null
    const overall = scored ? Number(scored.overallScore) : NaN
    const logo = `<span class="logo" data-a="toggle" title="${esc(this.collapsed ? this.s.expand : this.s.collapse)}">${LOGO_SVG}</span>`

    if (this.collapsed) {
      this.box.innerHTML = logo
    } else if (this.busy) {
      this.box.innerHTML = `${logo}<span class="spin"></span><span class="muted">${esc(this.busy)}</span>`
    } else {
      const canAct = words >= MIN_WORDS_MANUAL
      const dot = scored
        ? `<span class="dot sm" data-a="detail" style="background:${scoreColor(overall)}" title="${esc(this.s.score)}">${overall.toFixed(1)}</span>`
        : ''
      const optimize = scored
        ? `<button class="pbtn primary" data-a="optimize" title="${overall >= ALREADY_GOOD_SCORE ? esc(this.s.alreadyGood) : ''}">${esc(this.s.optimize)}</button>`
        : ''
      const flash = this.flashText ? `<span class="flash">${esc(this.flashText)}</span>` : ''
      this.box.innerHTML = `${logo}${dot}
        <button class="pbtn" data-a="score" ${canAct ? '' : 'disabled'} title="${canAct ? '' : esc(this.s.tooShort)}">${esc(this.s.evaluate)}</button>
        ${optimize}
        <button class="pbtn" data-a="save" ${canAct ? '' : 'disabled'} title="${canAct ? '' : esc(this.s.tooShort)}">${esc(this.s.saveToLibrary)}</button>
        ${flash}<button class="x" data-a="toggle" title="${esc(this.s.collapse)}">×</button>`
    }

    this.box.querySelectorAll('[data-a="toggle"]').forEach(el => el.addEventListener('click', () => this.toggle()))
    this.box.querySelector('[data-a="score"]')?.addEventListener('click', () => void scoreDraft(this.text))
    this.box.querySelector('[data-a="optimize"]')?.addEventListener('click', () => void optimizeDraft(this.text))
    this.box.querySelector('[data-a="save"]')?.addEventListener('click', () => void saveDraft(this.text))
    this.box.querySelector('[data-a="detail"]')?.addEventListener('click', () => {
      const text = this.text
      ui?.showDetail(scored, null, () => void optimizeDraft(text))
    })
    this.anchor()
  }

  private toggle() {
    this.collapsed = !this.collapsed
    void send({ type: 'setCollapsed', collapsed: this.collapsed })
    this.render()
  }
}
