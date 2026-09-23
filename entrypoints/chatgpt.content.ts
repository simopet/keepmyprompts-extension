import { defineContentScript } from 'wxt/utils/define-content-script'
import { runChatSite } from '../lib/chat-site'
import { SITES } from '../lib/sites'

/**
 * ChatGPT — an OPTIONAL site (lib/sites.ts): not in the manifest's content_scripts, so installing
 * or updating the extension grants nothing on chatgpt.com. The background registers this bundle
 * with chrome.scripting once the user enables ChatGPT from the popup and Chrome grants the
 * permission. `matches` is deliberately absent here: WXT would turn it into a required host permission.
 */
export default defineContentScript({
  registration: 'runtime',
  runAt: 'document_idle',
  main() {
    runChatSite(SITES['chatgpt.com'])
  },
})
