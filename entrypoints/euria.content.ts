import { defineContentScript } from 'wxt/utils/define-content-script'
import { runChatSite } from '../lib/chat-site'

/**
 * Euria (Infomaniak), inspected live on 2026-09-18: a React app whose composer is a plain
 * <textarea aria-label="Chiedi a Euria"> inside [data-testid="main-prompt"] (section#prompt-container),
 * with a <button type="submit" aria-label="Invia"> next to it (labels are localized, so the
 * selectors lean on data-testid and type="submit", not on the words).
 *
 * Two facts observed live that shape this config:
 * - The URL never changes with the conversation (it stays "/"), so "first message or follow-up"
 *   comes from the DOM: once a message is sent, bubbles with data-testid="user" / "assistant" appear.
 * - Inside kSuite (ksuite.infomaniak.com/<id>/euria) the app runs in an IFRAME whose document is
 *   euria.infomaniak.com, hence allFrames: without it the script would never start there.
 */
export default defineContentScript({
  matches: ['https://euria.infomaniak.com/*'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    runChatSite({
      host: 'euria.infomaniak.com',
      composerSelectors: [
        '[data-testid="main-prompt"] textarea',
        '#prompt-container textarea',
        'textarea[aria-label]',
      ],
      sendButtonSelector: '[data-testid="main-prompt"] button[type="submit"], #prompt-container button[type="submit"], button[aria-label="Invia"], button[aria-label*="send" i]',
      isNewConversation: () => document.querySelector('[data-testid="user"]') === null,
    })
  },
})
