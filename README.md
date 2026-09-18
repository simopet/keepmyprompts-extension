# Keep My Prompts — browser extension (prototype)

Captures the prompts you send in [Claude](https://claude.ai) into your [Keep My Prompts](https://www.keepmyprompts.com) library, scores them with Prompt Score and offers a one-click Quick Optimize, without leaving the chat.

**Status: prototype, Claude only, not on any store.** Selectors are hardcoded; ChatGPT, Gemini, remote selector config and one-click connect come in v1 once the prototype clears its gate.

## What it does

0. **Pre-send balloon.** A small pill sits above the composer with *Score prompt* and *Save to library*. Score the text you are about to send; once scored, *Optimize* unlocks (Quick Optimize) and the variant can replace the composer text before you send. Nothing is written to your library until you save or send. Collapse it to the logo with × (or a click on the logo), drag it by the logo to move it out of the way (the spot is remembered), double-click the logo to snap it back next to the composer. The post-send badge fades out by itself.
1. **Silent capture.** When you press Enter or click Send, the text of your prompt (only the prompt, never the reply) is saved to your library, in a system category called *From chats*. Sending the same text again bumps a reuse counter instead of creating a duplicate. Only messages that look like prompts are kept: the first message of a conversation needs at least 20 words, a follow-up at least 25, so "yes", "shorter" and "and point 3?" never reach your library.
2. **Prompt Score badge.** A small pill appears bottom-right with the score. Click it for the six criteria and a tip.
3. **Improve this prompt.** Quick Optimize runs; the variant opens in a panel with *Replace in composer* (your library prompt becomes the variant, the previous text is kept as a version) and *Save as version*.

You are asked for consent per site the first time. Pause everything, or disable a site, from the extension icon. Delete captured prompts any time from your library.

## Install (unpacked)

```bash
npm install
npm run build          # → .output/chrome-mv3
```

Chrome / Edge → `chrome://extensions` → Developer mode → *Load unpacked* → pick `.output/chrome-mv3`.

Then click the extension icon, choose the server, paste your **extension key** and Connect. In the prototype the key is created with `POST /api/api-keys` `{"name":"extension","scope":"ext"}` while logged in on the web app; v1 adds a one-click connect page.

## Development

```bash
npm run dev            # WXT dev server with hot reload (Chrome)
npm run typecheck
```

The extension ID is pinned through the manifest `key` (public half only) so it stays identical between unpacked loads and the store.

## Privacy

Sent to the server: the prompt text, the host (`claude.ai`), a timestamp. Never sent: replies, conversation titles or ids, anything from other tabs. Content is encrypted at rest with the same scheme as the web app. The token lives in `chrome.storage.local` and is only read by the background worker.

## License

MIT.
