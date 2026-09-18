import { defineConfig } from 'wxt'

// docs: https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Keep My Prompts',
    description:
      'Captures the prompts you send in Claude into your Keep My Prompts library, scores them and offers a one-click Quick Optimize.',
    // PUBLIC key. Pins the extension ID (ppgodjgclbacjhfpepijeagkmmfbibhh) so it is identical
    // between "load unpacked" and the Web Store: the KMP web app's one-click connect page will
    // address this ID via externally_connectable. The private half never enters the repo.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4hMCs1xDqiLjUnxYusjqkJtbT2gxqLDhYb8QnLOcZWDE/tQhH28HRQwmOTsybPB0ckmogd+OOyfEuRnW2QhKP5DZmijuoX8/6TO1k8D4Q30ac7sAfMtRBio38U0YPb0GIL3YpMAUJvOq0ADYNFCxYDHyoKZlgRkAcmaG/WqPHXR+gonduiutMgrggMelmSE8+rQ2CL5/IyE78Ky/qRPh1Mx76e/YDkstxbuZrsUK4RGwWYNDHoGFSXNKKN1OyXngYXfzzs1d5EyFqYaJSFCPh0/7mARvIPXlM5MNuUGUg28fbyfMyI/t5p4ynvSLhI74zDeUxqxzMzn7HOb4szjbKQIDAQAB',
    permissions: ['storage'],
    host_permissions: [
      'https://www.keepmyprompts.com/*',
      'https://dev.keepmyprompts.com/*',
      'http://localhost/*',
    ],
    // Only the extension's own pages may message it; the connect page lives here (v1).
    externally_connectable: { matches: ['https://www.keepmyprompts.com/*', 'https://dev.keepmyprompts.com/*'] },
  },
})
