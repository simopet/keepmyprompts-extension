import { defineContentScript } from 'wxt/utils/define-content-script'
import { runChatSite } from '../lib/chat-site'
import { SITES } from '../lib/sites'

/** Euria (Infomaniak) — selectors, signals and why allFrames in lib/sites.ts. */
export default defineContentScript({
  matches: SITES['euria.infomaniak.com'].matches,
  allFrames: true,
  runAt: 'document_idle',
  main() {
    runChatSite(SITES['euria.infomaniak.com'])
  },
})
