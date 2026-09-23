import { defineConfig } from 'wxt'
import { SITE_LIST } from './lib/sites'

// docs: https://wxt.dev/api/config.html
// Production builds talk to www.keepmyprompts.com only. The dev server and localhost exist just
// in development builds (`wxt` / `wxt build --mode development`): users must never see or pick them.
export default defineConfig({
  manifest: ({ mode }) => ({
    name: 'Keep My Prompts',
    description:
      'Captures the prompts you send in Claude, ChatGPT and Euria into your Keep My Prompts library, scores them and offers a one-click Quick Optimize.',
    // The Chrome Web Store's PUBLIC key for this listing (Package → View public key), so an unpacked
    // build gets the store's ID (kpdfoadeikmcchihgecmpkkkhpgfjifp) and Chrome treats it as the same
    // extension. The store REJECTS a manifest with `key` ("Il campo key non è consentito"), so the
    // store zip is built with KMP_STORE_ZIP=1 (npm run zip:store), which omits it. Do not load an
    // unpacked build alongside the store install: same ID, Chrome would fight over it.
    ...(process.env.KMP_STORE_ZIP ? {} : { key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs3+KqdJdHxnhRpeGeFS6BEp+SHxOk1/3tCZpUfrlqNocvsDtlpnWHZZO8nmXAhSGfCBL/ZPIXNlsRPf5iKE2kdOCd2N9BiB+0W4B3I6rsbjkEAgb2cDrJXhIpIP7ZWkbFjMQAHKbV7mBul+n+t/l5Wi10UGHFwKlKBM/NmLQ77ZoQ3Le2eSf6N1vhqKsWYaloryq+AVutpFlANFpZAYeApg04Y8w7tHgKO4NYe9oRdmqzptepVBhFsa3maaFWToA01wxSBzrbtd1TWcAOFMMBSzcEyTOfKAoxdltSK+ovNuRkY/gGzMeSyQEnqUfj8Hd38VpG7ceG5Wh7YdGct1a5wIDAQAB' }),
    // `scripting` registers the content scripts of optional sites at runtime (no install warning).
    permissions: ['storage', 'scripting'],
    // Sites the user enables from the popup (lib/sites.ts, optional: true). Requested at that
    // moment, never at install, so adding one in an update does not disable the extension.
    optional_host_permissions: SITE_LIST.filter(s => s.optional).flatMap(s => s.matches),
    host_permissions: [
      'https://www.keepmyprompts.com/*',
      ...(mode === 'development' ? ['https://dev.keepmyprompts.com/*', 'http://localhost/*'] : []),
    ],
    // Only the extension's own pages may message it; the connect page lives here (v1).
    externally_connectable: {
      matches: ['https://www.keepmyprompts.com/*', ...(mode === 'development' ? ['https://dev.keepmyprompts.com/*'] : [])],
    },
  }),
})
