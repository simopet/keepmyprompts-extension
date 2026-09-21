# Chrome Web Store listing — Keep My Prompts

Published 2026-09-21 (unlisted): https://chromewebstore.google.com/detail/keep-my-prompts/kpdfoadeikmcchihgecmpkkkhpgfjifp · store ID `kpdfoadeikmcchihgecmpkkkhpgfjifp`

Copy each block into the matching field of the Developer Dashboard. Plain text only: the store renders no
markdown in descriptions (line breaks are kept).

---

## Store listing

**Item name** (≤ 75 chars)
Keep My Prompts: Prompt Score in your chat

**Summary** (≤ 132 chars, shown in search results)
Score, optimize and save the prompts you write in Claude and Euria, right inside the chat, before you press Enter.

**Category**: Productivity → Workflow & Planning
**Language**: English (add Italian as a second listing language with the block below)

**Description** (≤ 16,000 chars)

Keep My Prompts brings Prompt Score and Quick Optimize into the chat window, so you can improve a prompt before you send it instead of after.

WHAT IT DOES

• Score before you send. A small pill sits above the composer. Press "Score prompt" and you get a Prompt Score on six criteria (clarity, context, structure, role, examples, step-by-step reasoning) plus one concrete tip. Nothing leaves the composer, nothing is saved.

• Optimize in one click. Once scored, "Optimize" runs Quick Optimize and shows an improved variant. "Replace in composer" puts it where your text was; send it as it is or edit it first.

• Save to your library. Press "Save to library", or simply send the message: prompts you actually use are captured into your Keep My Prompts library, in a dedicated "From chats" folder. Sending the same prompt again bumps a reuse counter instead of creating a duplicate. Short conversational messages ("yes", "shorter", "and point 3?") are ignored.

• Your library, everywhere. Everything you save is available at keepmyprompts.com with version history, scoring and optimization, and to any MCP client you connect.

SUPPORTED CHATS
Claude (claude.ai) and Euria (euria.infomaniak.com), including Euria inside kSuite. More coming.

PRIVACY, IN ONE PARAGRAPH
The extension captures only the text of the prompts you send, never the assistant's replies, conversation titles or anything else on the page. Capture is opt-in per site and can be paused from the extension icon at any time. Prompts are encrypted at rest. The extension runs only on the supported chat sites and does not read other tabs. Full details: https://www.keepmyprompts.com/privacy#extension

GETTING STARTED
1. Create a free account at keepmyprompts.com.
2. In Settings → Integrations → Browser extension, create an extension key.
3. Click the extension icon, paste the key, press Connect.
4. Open Claude or Euria, accept capture for the site, and write your next prompt.

PLANS
The free plan includes Prompt Score, Quick Optimize with a daily allowance and a library of 20 prompts. Pro and Ultimate add unlimited prompts, Deep Optimize and more daily optimizations. Pricing: https://www.keepmyprompts.com/pricing

Keep My Prompts is built in Europe. Support: support@keepmyprompts.com

---

## Descrizione (listing in italiano)

**Nome**
Keep My Prompts: Prompt Score nella chat

**Riepilogo** (≤ 132 caratteri)
Valuta, ottimizza e salva i prompt che scrivi in Claude ed Euria, direttamente nella chat, prima di premere Invio.

**Descrizione**

Keep My Prompts porta Prompt Score e Quick Optimize dentro la finestra della chat, così migliori un prompt prima di inviarlo invece che dopo.

COSA FA

• Valuta prima di inviare. Un piccolo pulsante compare sopra la casella di testo. Premi «Valuta prompt» e ottieni un Prompt Score su sei criteri (chiarezza, contesto, struttura, ruolo, esempi, ragionamento passo passo) e un consiglio concreto. Il testo resta nella casella, non viene salvato nulla.

• Ottimizza con un clic. Dopo la valutazione, «Ottimizza» avvia Quick Optimize e mostra una variante migliorata. «Sostituisci nella casella» la mette al posto del tuo testo: inviala così com'è o modificala prima.

• Salva nella libreria. Premi «Salva in libreria», oppure invia semplicemente il messaggio: i prompt che usi davvero vengono catturati nella tua libreria Keep My Prompts, in una cartella dedicata «Dalle chat». Inviare di nuovo lo stesso prompt aumenta un contatore di riuso invece di creare un doppione. I messaggi brevi di conversazione («sì», «più corto», «e il punto 3?») vengono ignorati.

• La tua libreria, ovunque. Tutto ciò che salvi è disponibile su keepmyprompts.com con storico delle versioni, valutazione e ottimizzazione, e in qualsiasi client MCP tu colleghi.

CHAT SUPPORTATE
Claude (claude.ai) ed Euria (euria.infomaniak.com), anche dentro kSuite. Altre in arrivo.

PRIVACY, IN UN PARAGRAFO
L'estensione cattura solo il testo dei prompt che invii, mai le risposte dell'assistente, i titoli delle conversazioni o altro contenuto della pagina. La cattura si attiva per ogni sito con il tuo consenso e si può mettere in pausa in qualsiasi momento dall'icona dell'estensione. I prompt sono cifrati a riposo. L'estensione funziona solo sui siti di chat supportati e non legge altre schede. Dettagli completi: https://www.keepmyprompts.com/privacy#extension

PER INIZIARE
1. Crea un account gratuito su keepmyprompts.com.
2. In Impostazioni → Integrazioni → Estensione browser, crea una chiave per l'estensione.
3. Clicca l'icona dell'estensione, incolla la chiave, premi Connect.
4. Apri Claude o Euria, accetta la cattura per il sito e scrivi il tuo prossimo prompt.

PIANI
Il piano gratuito include Prompt Score, Quick Optimize con una quota giornaliera e una libreria di 20 prompt. Pro e Ultimate aggiungono prompt illimitati, Deep Optimize e più ottimizzazioni al giorno. Prezzi: https://www.keepmyprompts.com/pricing

Keep My Prompts è sviluppato in Europa. Assistenza: support@keepmyprompts.com

---

## Privacy practices tab

**Single purpose description**
Score, optimize and save to the user's Keep My Prompts library the prompts they write in supported AI chat sites (Claude, Euria), directly from the chat composer.

**Permission justifications**

- `storage`: stores the user's extension key, the per-site capture consent, the pause switch and the position of the pill. Nothing else.
- Host permission `https://www.keepmyprompts.com/*`: the extension's own backend. All API calls (save a prompt, score it, optimize it, report a usage event) go to this host from the background service worker.
- Content script on `https://claude.ai/*` and `https://euria.infomaniak.com/*`: required to read the text of the composer when the user presses Score, Optimize, Save or sends a message, to display the pill and the score next to the composer, and to insert the optimized variant into the composer on the user's request. The extension does not run on any other site.

**Remote code**: No, the extension does not use remote code.

**Data usage** (tick these)
- Personally identifiable information: yes (the connected account's email and name, shown in the popup; read from our own API).
- Website content: yes (the text of the prompts the user writes in the supported chat composers, only when capture is on or the user presses Score/Optimize/Save).
- User activity: yes (product usage events such as "prompt captured", "score viewed", linked to the account, without prompt text).
- Not collected: health, financial and payment info, authentication info other than the extension's own key, personal communications (the assistant's replies are never read), location, web history.

**Certifications** (tick all three)
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**
https://www.keepmyprompts.com/privacy#extension

---

## Distribution

- Visibility: **Unlisted** (installable from the link only) for the test phase.
- Regions: all.
- Pricing: free (in-app plans are handled on the website, not through the store).
