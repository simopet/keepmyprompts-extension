import { defineContentScript } from 'wxt/utils/define-content-script'
import { runChatSite } from '../lib/chat-site'
import { SITES } from '../lib/sites'

/** claude.ai — selectors and signals in lib/sites.ts. */
export default defineContentScript({
  matches: SITES['claude.ai'].matches,
  runAt: 'document_idle',
  main() {
    runChatSite(SITES['claude.ai'])
  },
})
