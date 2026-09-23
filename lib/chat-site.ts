import { browser } from 'wxt/browser'
import type { CaptureResult, Rating, Request, Response, State, Variant } from './messages'
import type { SiteConfig } from './sites'
import { t, type Strings } from './strings'

/**
 * Shared logic of every chat-site content script. Each entrypoint passes its SiteConfig from
 * lib/sites.ts and calls runChatSite().
 *
 * Two flows live here (plan § 1 and § 1bis):
 *
 * 1. SILENT CAPTURE, after a send — "read on intent, confirm on empty": when the user presses
 *    Enter (no Shift) in the COMPOSER or clicks Send we read the composer text immediately, then
 *    600 ms later check that the composer emptied. Only then the text is treated as sent. A message
 *    is captured only when it looks like a prompt (decision 6): the FIRST message of a conversation
 *    needs at least 20 words, a follow-up at least 25. Skips are counted as events.
 *
 * 2. PRE-SEND BALLOON (decision 7) — a compact pill anchored to the composer, always visible,
 *    with «Score prompt» and «Save to library»; «Optimize» unlocks after the score. Everything
 *    pre-send works on the composer text and writes NOTHING to the library until the user saves
 *    or sends: «Replace in composer» is a local action, the send then captures the final text.
 *    The manual buttons bypass the word thresholds (the user chose) but need 10 words, the
 *    minimum Quick Optimize accepts.
 *
 * State (connected, paused, per-site consent) is re-read from the worker whenever the settings
 * change, so the popup's toggles apply to open tabs without a reload.
 */

let site: SiteConfig
const CONFIRM_DELAY_MS = 600
const MIN_WORDS_FIRST_MESSAGE = 20
const MIN_WORDS_FOLLOW_UP = 25
const MIN_WORDS_MANUAL = 10
const DUPLICATE_WINDOW_MS = 5000
const ALREADY_GOOD_SCORE = 4.5

const COMPOSER_CHECK_DELAY_MS = 10_000

export function runChatSite(config: SiteConfig) {
  // The popup's «enable» injects the script into tabs already open; never run twice in one page.
  const g = globalThis as { __kmpChatSite?: boolean }
  if (g.__kmpChatSite) return
  g.__kmpChatSite = true
  site = config
  void boot()
}

// ---------- messaging ----------

/**
 * After an extension update (or a reload from chrome://extensions) the content scripts already
 * running in open tabs are orphaned: the page keeps them, but every runtime call throws
 * «Extension context invalidated». Without this the balloon stays on screen and silently does
 * nothing; with it the UI is taken down and the user is told to reload.
 */
let orphaned = false

async function send<T>(msg: Request): Promise<Response<T>> {
  if (orphaned) return { ok: false, error: 'context_invalidated' }
  try {
    const res = (await browser.runtime.sendMessage(msg)) as Response<T> | undefined
    return res ?? { ok: false, error: 'no_response' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!browser.runtime?.id || /context invalidated/i.test(message)) {
      onOrphaned()
      return { ok: false, error: 'context_invalidated' }
    }
    return { ok: false, error: message }
  }
}

function onOrphaned() {
  if (orphaned) return
  orphaned = true
  balloon?.destroy()
  balloon = null
  ui?.showMessage(strings.reloadPage)
}

// ---------- DOM helpers ----------

function isTextarea(el: HTMLElement): el is HTMLTextAreaElement {
  return el.tagName === 'TEXTAREA'
}

function findComposer(): HTMLElement | null {
  for (const sel of site.composerSelectors) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.offsetParent === null) continue // hidden
      if (isTextarea(el) || el.isContentEditable) return el
    }
  }
  return null
}

function composerText(el: HTMLElement | null): string {
  if (!el) return ''
  const raw = isTextarea(el) ? el.value : el.innerText
  return (raw ?? '').replace(/\u00a0/g, ' ').trim()
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

function replaceComposerText(text: string): boolean {
  const el = findComposer()
  if (!el) return false
  el.focus()
  if (isTextarea(el)) {
    // React-controlled textareas ignore a plain `.value =`: go through the native setter, then
    // fire `input` so the framework picks the new value up.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (setter) setter.call(el, text)
    else el.value = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    return true
  }
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

/** Whitespace-insensitive equality: ProseMirror may re-flow line breaks and trailing spaces on insert. */
function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
}

/**
 * The optimizer already scored the variant it returned; turn that into the Rating shape the badge
 * and the balloon render, so replacing the composer text with a variant never triggers a second
 * scoring call when the user sends it.
 */
function ratingFromPromptScore(ps: Variant['promptScore']): Rating | null {
  if (!ps || typeof ps !== 'object' || typeof ps.overall !== 'number') return null
  const scores: Record<string, number> = {}
  for (const [k, v] of Object.entries(ps)) {
    if (k !== 'overall' && k !== 'tip' && typeof v === 'number') scores[k] = v
  }
  const system = 'behavioralClarity' in scores
  return { scores, overallScore: ps.overall, tip: typeof ps.tip === 'string' ? ps.tip : null, promptType: system ? 'system_prompt' : 'user_prompt' }
}


// ---------- boot and state ----------

let strings: Strings = t('en')
let state: State | null = null
let ui: Ui | null = null
let balloon: Balloon | null = null
let consentOpen = false
let captureArmed = false
let lastCaptured = { text: '', at: 0 }
/** The last composer text scored from the balloon, reused by the post-send badge when identical. */
let draft: { text: string; rating: Rating | null } = { text: '', rating: null }

const browserLocale = (): 'en' | 'it' => (navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en')

async function boot() {
  // Leftovers of an instance orphaned by an extension update, if this one was injected over it.
  document.querySelectorAll('[data-kmp-ext]').forEach(n => n.remove())
  const res = await send<State>({ type: 'getState', host: site.host, locale: browserLocale() })
  if (!res.ok) return
  state = res.data
  strings = t(state.locale)
  ui = new Ui(strings)
  apply()
  // Popup toggles (pause, per-site capture, connect/disconnect) reach this tab without a reload.
  // The change payload is not read: the worker stays the one place that interprets settings.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void refreshState()
  })
  scheduleComposerCheck()
}

async function refreshState() {
  if (orphaned) return
  const res = await send<State>({ type: 'getState', host: site.host })
  if (!res.ok) return
  state = res.data
  apply()
}

/** Brings the page in line with `state`; safe to call any number of times. */
function apply() {
  if (!state || !ui || orphaned) return
  if (!state.connected || state.paused) {
    balloon?.destroy()
    balloon = null
    if (consentOpen) ui.hide()
    consentOpen = false
    return
  }
  if (state.consent === undefined) {
    if (!consentOpen) {
      consentOpen = true
      ui.showConsent(async enabled => {
        consentOpen = false
        state = { ...(state as State), consent: enabled }
        apply()
        await send({ type: 'setConsent', host: site.host, enabled })
      })
    }
    return
  }
  if (consentOpen) {
    // Answered in another tab or from the popup.
    consentOpen = false
    ui.hide()
  }
  armCaptureListeners()
  if (!balloon) balloon = new Balloon(strings, state.collapsed, state.balloonPos)
}

/** Silent capture happens only with the user's consent for this site, never while paused. */
function captureEnabled(): boolean {
  if (!state || orphaned) return false
  if (!state.connected || state.paused || state.consent !== true) return false
  return site.captureAllowed ? site.captureAllowed() : true
}

/**
 * A chat page where no composer matches any selector means the site changed its markup: report
 * it once per page, so a breakage shows up in the admin panel instead of in a user's complaint.
 */
function scheduleComposerCheck() {
  const check = () => {
    if (!state?.connected || !site.isChatPage() || findComposer()) return
    void send({ type: 'track', name: 'ext_composer_missing', properties: { host: site.host } })
  }
  window.setTimeout(() => {
    if (!document.hidden) return check()
    const onVisible = () => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', onVisible)
      window.setTimeout(check, 3000)
    }
    document.addEventListener('visibilitychange', onVisible)
  }, COMPOSER_CHECK_DELAY_MS)
}

// ---------- flow 1: silent capture after a send ----------

function armCaptureListeners() {
  if (captureArmed) return
  captureArmed = true
  document.addEventListener(
    'keydown',
    e => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      const target = e.target as HTMLElement | null
      // Only Enter inside the composer is a send. Enter in another editor on the page (ChatGPT's
      // Canvas, an «edit message» box) is a newline or a different action, and the confirmation
      // below looks at the composer, so it would mistake that editor's text for a sent prompt.
      const composer = findComposer()
      if (!target || !composer || !composer.contains(target)) return
      armCapture(composerText(composer))
    },
    true
  )
  document.addEventListener(
    'click',
    e => {
      const btn = (e.target as Element | null)?.closest?.(site.sendButtonSelector)
      if (!btn) return
      armCapture(composerText(findComposer()))
    },
    true
  )
}

function armCapture(text: string) {
  if (!text || !captureEnabled()) return
  const signal = site.isNewConversation() // read BEFORE the send changes the URL
  const first = signal !== false // unknown counts as an opener
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

type Failure = Extract<Response, { ok: false }>

/**
 * What to tell the user when a call fails: quotas and connection get their own words, anything
 * else the generic error. null = say nothing (an orphaned script already asked for a reload).
 */
function failureMessage(res: Failure): string | null {
  if (res.error === 'context_invalidated') return null
  if (res.status === 401) return strings.notConnected
  if (res.error === 'rate_limit_exceeded') return strings.scoreLimit(res.resetInMinutes)
  if (res.error === 'daily_capture_limit') return strings.captureLimit
  if (res.error === 'dailyLimitReached') return strings.dailyLimit
  if (res.error === 'tooShort') return strings.tooShort
  return strings.error
}

function showFailure(res: Failure) {
  const message = failureMessage(res)
  if (message) ui?.showMessage(message)
  else ui?.hide()
}

async function onSent(text: string) {
  if (!ui) return
  ui.showScoring()
  const cap = await send<CaptureResult>({ type: 'capture', host: site.host, content: text })
  if (!cap.ok) {
    if (cap.error === 'capture_disabled') return ui.hide()
    if (cap.error !== 'context_invalidated' && cap.status !== 401) {
      void send({ type: 'track', name: 'ext_capture_failed', properties: { reason: cap.error } })
    }
    return showFailure(cap)
  }

  const data = cap.data
  const promptId = 'prompt_id' in data ? data.prompt_id : null
  const atLimit = 'at_limit' in data && data.at_limit

  // If the balloon already scored exactly this text, reuse it instead of paying a second call.
  let rating: Rating | null = null
  // Why there is no number, when there is none: a spent scoring quota must not read as a bug.
  let scoreError: string | null = null
  if (draft.rating && sameText(draft.text, text)) {
    rating = draft.rating
  } else {
    const scoreRes = await send<{ success: boolean; rating?: Rating; error?: string }>(
      promptId ? { type: 'score', prompt_id: promptId } : { type: 'score', content: text }
    )
    if (orphaned) return
    rating = scoreRes.ok && scoreRes.data.success ? scoreRes.data.rating ?? null : null
    if (!scoreRes.ok) scoreError = failureMessage(scoreRes)
  }

  ui.showScored({
    rating,
    scoreError,
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
  if (variant === null) return ui.hide()
  if (typeof variant === 'string') return ui.showMessage(variant)

  ui.showVariant(variant, {
    primary: {
      label: strings.replace,
      run: async () => {
        // Replace = the web's "apply variant": the library prompt becomes the variant (current text
        // snapshotted as a version) AND the composer shows it. Sending it then dedups to the same prompt.
        const saved = await send({ type: 'saveVersion', prompt_id: promptId, content: variant.content, apply: true })
        const replaced = replaceComposerText(variant.content)
        draft = { text: variant.content, rating: ratingFromPromptScore(variant.promptScore) }
        balloon?.render()
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

/**
 * Turns an optimize response into a variant, or into the message to show instead (null = nothing
 * to show). The daily limit arrives as a 403, i.e. as a failed call, not as `success: false`.
 */
function unwrapVariant(res: Response<OptimizeBody>): Variant | string | null {
  if (!res.ok) return failureMessage(res)
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
  balloon?.setBusy(null)
  const rating = res.ok && res.data.success ? res.data.rating ?? null : null
  if (!rating) {
    return res.ok ? ui.showMessage(strings.error) : showFailure(res)
  }
  draft = { text, rating }
  void send({ type: 'track', name: 'ext_draft_scored', properties: { score: Number(rating.overallScore), host: site.host } })
  balloon?.render()
}

async function optimizeDraft(text: string) {
  if (!balloon || !ui) return
  balloon.setBusy(strings.optimizing)
  const res = await send<OptimizeBody>({ type: 'optimize', content: text })
  balloon?.setBusy(null)
  const variant = unwrapVariant(res)
  if (variant === null) return
  if (typeof variant === 'string') return ui.showMessage(variant)
  const remaining = res.ok ? res.data.remaining : undefined

  ui.showVariant(variant, {
    note: typeof remaining === 'number' ? strings.remainingQuick(remaining) : undefined,
    primary: {
      label: strings.replace,
      run: () => {
        // Pre-send: local only. Nothing is written until the user saves or sends.
        const replaced = replaceComposerText(variant.content)
        // The composer now holds the variant, whose score we already have: the balloon shows it,
        // «Score» stays disabled, and the send reuses it instead of scoring a third time.
        draft = { text: variant.content, rating: ratingFromPromptScore(variant.promptScore) }
        balloon?.render()
        ui?.showMessage(replaced ? strings.replacedLocal : strings.error)
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
  const cap = await send<CaptureResult>({ type: 'capture', host: site.host, content: text, manual: true })
  balloon?.setBusy(null)
  if (!cap.ok) return showFailure(cap)
  if ('at_limit' in cap.data && cap.data.at_limit) {
    return ui.showAtLimit(cap.data.max ?? 20)
  }
  balloon?.flash(strings.saved)
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
.pill .logo { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; cursor: grab; flex: none; touch-action: none; user-select: none; }
.pill .logo:active { cursor: grabbing; }
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

function makeShadowHost(): { host: HTMLDivElement; root: ShadowRoot; box: HTMLDivElement } {
  const host = document.createElement('div')
  host.setAttribute('data-kmp-ext', '')
  document.documentElement.appendChild(host)
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = CSS
  root.appendChild(style)
  const box = document.createElement('div')
  root.appendChild(box)
  return { host, root, box }
}

// ---------- UI: post-send badge and panels (bottom-right) ----------

type VariantActions = {
  primary: { label: string; run: () => void | Promise<void> }
  secondary: { label: string; run: () => void | Promise<void> }
  note?: string
}

class Ui {
  private box: HTMLDivElement
  private hideTimer: number | undefined

  constructor(private s: Strings) {
    this.box = makeShadowHost().box
    this.box.className = 'kmp'
    this.hide()
  }

  hide() {
    window.clearTimeout(this.hideTimer)
    this.box.onmouseenter = null
    this.box.onmouseleave = null
    this.box.innerHTML = ''
    this.box.style.display = 'none'
  }

  private show(html: string) {
    window.clearTimeout(this.hideTimer)
    this.box.onmouseenter = null
    this.box.onmouseleave = null
    this.box.innerHTML = html
    this.box.style.display = ''
    this.anchor()
  }

  /**
   * Everything opens next to the balloon: right edges aligned, just above it (or below it when the
   * balloon sits in the upper half of the window). Dragging the balloon therefore moves every panel
   * too, which is how the user gets it out of the way of whatever Claude renders near the composer.
   * Falls back to the bottom-right corner when there is no balloon yet.
   */
  private anchor() {
    const rect = balloon?.rect()
    this.box.style.top = ''
    this.box.style.bottom = ''
    if (!rect) {
      this.box.style.right = '20px'
      this.box.style.bottom = '96px'
      return
    }
    this.box.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`
    if (rect.top > window.innerHeight / 2) {
      this.box.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`
    } else {
      this.box.style.top = `${Math.min(window.innerHeight - 60, rect.bottom + 6)}px`
    }
  }

  /** The post-send badge fades out on its own unless the user is hovering it. */
  private autoHide(ms: number) {
    window.clearTimeout(this.hideTimer)
    let hovered = false
    this.box.onmouseenter = () => { hovered = true }
    this.box.onmouseleave = () => { hovered = false; this.hideTimer = window.setTimeout(() => this.hide(), 1500) }
    this.hideTimer = window.setTimeout(() => { if (!hovered) this.hide() }, ms)
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
    scoreError: string | null
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
    this.q('[data-a="open"]')?.addEventListener('click', () => this.showDetail(opts.rating, opts.atLimit, opts.onOptimize, opts.scoreError))
    // A confirmation, not a dialog: it goes away by itself (longer when there is something to act on).
    this.autoHide(opts.atLimit ? 12000 : 6000)
  }

  /** Criteria + tip panel; used by the post-send badge and by the balloon's score dot. */
  showDetail(rating: Rating | null, atLimit: { max: number } | null, onOptimize: (() => void) | null, scoreError: string | null = null) {
    const overall = rating ? Number(rating.overallScore) : NaN
    const rows = rating
      ? Object.entries(rating.scores)
          .map(([k, v]) => `<div class="row"><span>${esc(this.s.criteria[k] ?? k)}</span><b>${esc(String(v))}</b></div>`)
          .join('')
      : ''
    const tip = rating?.tip
      ? `<div class="tip"><b>${esc(this.s.tip)}:</b> ${esc(rating.tip)}</div>`
      : !rating && scoreError ? `<div class="tip">${esc(scoreError)}</div>` : ''
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
  private host: HTMLDivElement
  private box: HTMLDivElement
  private interval: number
  private frame = 0
  private onResize = () => this.anchor()
  /** Scroll fires continuously while a reply streams: re-anchor at most once per frame. */
  private onScroll = () => {
    if (this.frame) return
    this.frame = window.requestAnimationFrame(() => { this.frame = 0; this.anchor() })
  }
  private busy: string | null = null
  private flashText: string | null = null
  private flashTimer: number | undefined
  private text = ''
  /** Set once the user drags the pill: from then on it stays where they left it. */
  private pos: { x: number; y: number } | null
  private dragging = false

  constructor(private s: Strings, private collapsed: boolean, pos: { x: number; y: number } | null) {
    this.pos = pos
    const shadow = makeShadowHost()
    this.host = shadow.host
    this.box = shadow.box
    this.box.className = 'pill'
    this.box.style.display = 'none'
    this.render()
    // Re-anchor cheaply: the sites re-render their composer often, and a rAF loop would be overkill.
    this.interval = window.setInterval(() => this.tick(), 250)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('scroll', this.onScroll, true)
  }

  /** Paused from the popup, disconnected, or orphaned by an update: leave no trace on the page. */
  destroy() {
    window.clearInterval(this.interval)
    window.clearTimeout(this.flashTimer)
    window.cancelAnimationFrame(this.frame)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('scroll', this.onScroll, true)
    this.host.remove()
  }

  /** Current viewport rectangle, used by the panels to open next to the pill. */
  rect(): DOMRect | null {
    if (this.box.style.display === 'none') return null
    return this.box.getBoundingClientRect()
  }

  /**
   * Drag by the logo. A press that moves less than 5 px is a click (collapse/expand); a longer one
   * moves the pill and remembers the spot. Double-click on the logo goes back to following the composer.
   */
  private installDrag(handle: HTMLElement) {
    handle.addEventListener('pointerdown', down => {
      if (down.button !== 0) return
      const start = { x: down.clientX, y: down.clientY }
      const origin = this.box.getBoundingClientRect()
      let moved = false
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - start.x
        const dy = ev.clientY - start.y
        if (!moved && Math.hypot(dx, dy) < 5) return
        moved = true
        this.dragging = true
        this.pos = this.clamp({ x: origin.left + dx, y: origin.top + dy })
        this.applyPos()
      }
      const up = () => {
        document.removeEventListener('pointermove', move, true)
        document.removeEventListener('pointerup', up, true)
        if (moved) {
          this.dragging = false
          void send({ type: 'setBalloonPos', pos: this.pos })
        } else {
          this.toggle()
        }
      }
      document.addEventListener('pointermove', move, true)
      document.addEventListener('pointerup', up, true)
      down.preventDefault()
    })
    handle.addEventListener('dblclick', () => {
      this.pos = null
      void send({ type: 'setBalloonPos', pos: null })
      this.anchor()
    })
  }

  private clamp(p: { x: number; y: number }): { x: number; y: number } {
    const w = this.box.offsetWidth
    const h = this.box.offsetHeight
    return {
      x: Math.max(8, Math.min(window.innerWidth - w - 8, p.x)),
      y: Math.max(8, Math.min(window.innerHeight - h - 8, p.y)),
    }
  }

  private applyPos() {
    if (!this.pos) return
    this.box.style.display = ''
    this.box.style.left = `${this.pos.x}px`
    this.box.style.top = `${this.pos.y}px`
  }

  /** Follows the composer text; when it changes, a previous draft score no longer applies. */
  private tick() {
    if (document.hidden) return // nothing to follow in a background tab; innerText forces a layout
    const now = composerText(findComposer())
    if (now !== this.text) {
      this.text = now
      this.render()
    }
    this.anchor()
  }

  private anchor() {
    if (this.dragging) return
    if (this.pos) {
      this.pos = this.clamp(this.pos)
      this.applyPos()
      return
    }
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
    const scored = draft.rating && sameText(draft.text, this.text) ? draft.rating : null
    const overall = scored ? Number(scored.overallScore) : NaN
    const logo = `<span class="logo" data-a="handle" title="${esc(this.s.dragHint)}">${LOGO_SVG}</span>`

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
        <button class="pbtn" data-a="score" ${canAct && !scored ? '' : 'disabled'} title="${scored ? esc(this.s.alreadyScored) : canAct ? '' : esc(this.s.tooShort)}">${esc(this.s.evaluate)}</button>
        ${optimize}
        <button class="pbtn" data-a="save" ${canAct ? '' : 'disabled'} title="${canAct ? '' : esc(this.s.tooShort)}">${esc(this.s.saveToLibrary)}</button>
        ${flash}<button class="x" data-a="toggle" title="${esc(this.s.collapse)}">×</button>`
    }

    this.box.querySelectorAll('[data-a="toggle"]').forEach(el => el.addEventListener('click', () => this.toggle()))
    const handle = this.box.querySelector<HTMLElement>('[data-a="handle"]')
    if (handle) this.installDrag(handle)
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
