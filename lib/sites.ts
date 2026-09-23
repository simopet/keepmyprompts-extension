/**
 * Every chat site the extension knows, in one place: the content scripts read their selectors from
 * here, the popup builds its per-site toggles from here, the background registers the optional
 * sites from here. Adding a site = one entry below + one entrypoint + the host in the server's
 * ALLOWED_HOSTS (capture route). The shape is also the one the remote config of plan § 4.3 will
 * serve, so moving selectors server-side later changes where this object comes from, not its form.
 *
 * Two kinds of site:
 * - `optional: false` — declared in the manifest, active from install (Claude, Euria: what the
 *   store listing was approved with).
 * - `optional: true` — `optional_host_permissions`: the extension does NOT run there until the user
 *   enables the site from the popup, which asks Chrome for the permission; the background then
 *   registers the content script at runtime. Adding such a site in an update raises no new
 *   permission warning, so Chrome does not disable the extension for existing users.
 */

import type { PublicPath } from 'wxt/browser'

export type SiteHost = 'claude.ai' | 'euria.infomaniak.com' | 'chatgpt.com'

export interface SiteConfig {
  host: SiteHost
  /** What the popup shows. */
  label: string
  matches: string[]
  optional: boolean
  /** Runtime-registered sites only: the bundle WXT emits for the entrypoint (typed, so a rename fails the build). */
  script?: Extract<PublicPath, `${string}.js`>
  allFrames?: boolean
  /** Tried in order; the first visible match that is a textarea or contenteditable wins. */
  composerSelectors: string[]
  sendButtonSelector: string
  /**
   * true = the message about to be sent opens a conversation; false = it is a follow-up;
   * null = the site gives no usable signal, treat every message as an opener (20-word threshold).
   */
  isNewConversation: () => boolean | null
  /** false = never capture silently on this page (the balloon's manual buttons still work). */
  captureAllowed?: () => boolean
  /** true = a composer is expected on this page: used to report selectors that stopped matching. */
  isChatPage: () => boolean
}

const path = () => location.pathname.replace(/\/+$/, '')

export const SITES: Record<SiteHost, SiteConfig> = {
  /** claude.ai: ProseMirror composer, URL /new → /chat/<id> on the first send. */
  'claude.ai': {
    host: 'claude.ai',
    label: 'Claude',
    matches: ['https://claude.ai/*'],
    optional: false,
    composerSelectors: [
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'fieldset [contenteditable="true"]',
      '[contenteditable="true"]',
    ],
    sendButtonSelector: 'button[aria-label*="send" i], button[aria-label*="invia" i], button[type="submit"]',
    isNewConversation: () => {
      const p = path()
      return p === '' || p === '/new' || p.startsWith('/new/')
    },
    isChatPage: () => /^\/(new|chat\/|project\/)/.test(location.pathname),
  },

  /**
   * Euria (Infomaniak), inspected live on 2026-09-18: a React app whose composer is a plain
   * <textarea aria-label="Chiedi a Euria"> inside [data-testid="main-prompt"] (section#prompt-container),
   * with a <button type="submit" aria-label="Invia"> next to it (labels are localized, so the
   * selectors lean on data-testid and type="submit", not on the words).
   *
   * The URL never changes with the conversation (it stays "/"), so "first message or follow-up"
   * comes from the DOM: once a message is sent, bubbles with data-testid="user" / "assistant" appear.
   * Inside kSuite (ksuite.infomaniak.com/<id>/euria) the app runs in an IFRAME whose document is
   * euria.infomaniak.com, hence allFrames: without it the script would never start there.
   */
  'euria.infomaniak.com': {
    host: 'euria.infomaniak.com',
    label: 'Euria (Infomaniak)',
    matches: ['https://euria.infomaniak.com/*'],
    optional: false,
    allFrames: true,
    composerSelectors: [
      '[data-testid="main-prompt"] textarea',
      '#prompt-container textarea',
      'textarea[aria-label]',
    ],
    sendButtonSelector: '[data-testid="main-prompt"] button[type="submit"], #prompt-container button[type="submit"], button[aria-label="Invia"], button[aria-label*="send" i]',
    isNewConversation: () => document.querySelector('[data-testid="user"]') === null,
    isChatPage: () => true,
  },

  /**
   * ChatGPT: the composer is a ProseMirror contenteditable div#prompt-textarea (a hidden <textarea>
   * fallback sits next to it, skipped because it is not rendered). Send is
   * button[data-testid="send-button"]; while a reply streams the same slot becomes the stop button,
   * Enter does not send and the composer keeps its text, so "confirm on empty" drops it.
   * URLs: "/" and "/g/<gpt>" open a conversation, "/c/<id>" and "/g/<gpt>/c/<id>" are follow-ups.
   * Temporary chats (?temporary-chat=true) are never captured: the user asked ChatGPT itself not to
   * keep them, and saving them in our library would contradict that choice.
   */
  'chatgpt.com': {
    host: 'chatgpt.com',
    label: 'ChatGPT',
    matches: ['https://chatgpt.com/*'],
    optional: true,
    script: '/content-scripts/chatgpt.js',
    composerSelectors: [
      '#prompt-textarea[contenteditable="true"]',
      'form div.ProseMirror[contenteditable="true"]',
      'form [contenteditable="true"]',
      'textarea#prompt-textarea',
    ],
    sendButtonSelector: 'button[data-testid="send-button"], button#composer-submit-button',
    isNewConversation: () => !/\/c\/[^/]+/.test(location.pathname),
    captureAllowed: () => new URLSearchParams(location.search).get('temporary-chat') !== 'true',
    isChatPage: () => path() === '' || /^\/(c|g)\//.test(location.pathname),
  },
}

export const SITE_LIST: SiteConfig[] = Object.values(SITES)
