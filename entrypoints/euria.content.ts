import { defineContentScript } from 'wxt/utils/define-content-script'
import { runChatSite } from '../lib/chat-site'

/**
 * Euria (Infomaniak), inspected live on 2026-09-18: a React app whose composer is a plain
 * <textarea aria-label="Chiedi a Euria"> inside [data-testid="main-prompt"] (section#prompt-container),
 * with a <button type="submit" aria-label="Invia"> next to it (labels are localized, so the
 * selectors lean on data-testid and type="submit", not on the words). A new chat lives at "/";
 * anything else is treated as a follow-up.
 */
export default defineContentScript({
  matches: ['https://euria.infomaniak.com/*'],
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
      isNewConversation: () => location.pathname.replace(/\/+$/, '') === '',
    })
  },
})
