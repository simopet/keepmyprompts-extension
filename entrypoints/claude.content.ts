import { defineContentScript } from 'wxt/utils/define-content-script'
import { runChatSite } from '../lib/chat-site'

/** claude.ai: ProseMirror composer, URL /new → /chat/<id> on the first send. */
export default defineContentScript({
  matches: ['https://claude.ai/*'],
  runAt: 'document_idle',
  main() {
    runChatSite({
      host: 'claude.ai',
      composerSelectors: [
        'div.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'fieldset [contenteditable="true"]',
        '[contenteditable="true"]',
      ],
      sendButtonSelector: 'button[aria-label*="send" i], button[aria-label*="invia" i], button[type="submit"]',
      isNewConversation: () => {
        const p = location.pathname.replace(/\/+$/, '')
        return p === '' || p === '/new' || p.startsWith('/new/')
      },
    })
  },
})
