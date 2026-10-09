# Testing and verification

## Test layers

| Layer | Command | What it covers | Needs |
| --- | --- | --- | --- |
| Type checking | `npm run typecheck` | Main, preload, renderer and tests (strict TypeScript). | — |
| Unit | `npm test` (`tests/unit`) | Audio DSP (resampler anti-aliasing, VAD segmentation on synthetic and real speech, WAV codec); question detection and answer tracking; **screen auto-answer** (watcher settling, dedupe, video-next-to-text, unreadable screens, busy/cooldown, stop; answerable-text and new-content heuristics); hallucination and speaker-echo filters; context builder (budgeting, screen quality, image policy, rolling summary plan); summary parsing; export; settings sanitising; DPAPI credential store (with a fake encryptor); meeting store (JSONL crash tolerance, retention, path-traversal guard); provider error mapping; model capability heuristics; **every provider adapter against a wire-compatible mock server** (SSE formats, request bodies, auth headers, parameter fallbacks, cancellation); transcription service (retries, backlog merge, auto-fallback to on-device Whisper, reset). | Nothing — no network, no keys. |
| Integration | `npm test` (`tests/integration`) | The full meeting workflow headlessly: the real `SessionController` and services, real Tesseract OCR on a slide image, the real OpenAI and Anthropic adapters against the mock server, real persistence. Covers: start → remote question transcribed and detected → screen capture with overlay masking and OCR → grounded answer → explain screen with image → **provider switch mid-meeting** → refine → error handling → pause/resume → stop with auto-summary → history and Markdown export. Also **Auto mode on the screen** (real OCR of a quiz slide → answered once with the screenshot; repaint not re-answered; plain slides never sent to the model; a model reply of NOTHING_TO_ANSWER shows nothing; pause/resume; Manual mode never watches; Manual *Answer* answers an on-screen question when nothing was asked aloud), auto-capture with change detection, **auto-answer** (each remote question answered without a click, a question asked during the cooldown answered afterwards, switching on mid-meeting answers the question just asked, switching off cancels a pending answer), and rolling summaries for long meetings. | Nothing. |
| End-to-end | `npm run test:e2e` | The built Electron app driven by Playwright against the mock providers. Covers: three windows and cross-origin isolation; **fake microphone → AudioWorklet → VAD → transcription → UI**; **Windows system-audio loopback acquisition**; capture of a real window → OCR → UI; **dark-theme code read as Readable**; **auto-capture picking up the next slide with the same layout**; answer streaming; ask anything; overlay; pause/resume/stop → history; **a saved API key survives an app restart**; ChatGPT plan sign-in; DeepSeek key → answer; **appearance** (every theme reaches both windows with the right native light/dark mode and window background; accent, density, corners and font applied and measured; restore defaults); **Answer mode** (Manual vs Auto, in sync between the main window and the panel); **Auto mode on the screen** (a question shown in a fixture window answered without a click, not answered twice, pause/resume, back to Manual — only fixture windows are ever watched); **Questions to ask** (grounded in the transcript, per-question and copy-all copy, More questions without repeats — copies go to an in-memory list, never the real clipboard); **response speed** (connections reused across a 6 s pause — the test fails without the keep-alive agent — and timing shown on cards); settings never expose keys. Windows stay hidden and no global shortcuts are registered (`MYCLUELY_HEADLESS_UI=1`). | Windows desktop session. |
| End-to-end (packaged) | `$env:MYCLUELY_EXECUTABLE='release/1.0.3/win-unpacked/MyCluely.exe'; npx playwright test app.spec persistence screen chatgpt deepseek theme auto-answer questions speed screen-auto` | The same suites on the packaged app: asar layout, unpacked Tesseract worker and data, `app://` protocol. | `npm run package:dir` first. |
| On-device Whisper | `$env:MYCLUELY_E2E_WHISPER='1'; npx playwright test whisper` | Real speech (System.Speech TTS fixture) → on-device Whisper (WebGPU or WASM) → transcript, no mocks and no keys. | Internet once (model download). |
| Docs screenshots | `$env:MYCLUELY_SCREENSHOTS='1'; npx playwright test screenshots` | Regenerates `docs/images/*` from a scripted meeting (light theme; set `MYCLUELY_SCREENSHOT_THEME=dark` and `MYCLUELY_SCREENSHOT_DIR` for dark previews). | — |

Fixtures are generated with built-in Windows components (`scripts/make-fixtures.ps1`: System.Speech for speech WAVs, System.Drawing for the slide image). The mock provider server is `tests/helpers/mock-providers.ts`; the headless harness is `tests/helpers/session-harness.ts`.

## Verification record — version 1.0.9 (2026-10-09)

Environment: Windows 11 Pro (build 26300), Node 26.7.0, Electron 44.7.0 (Chromium 152, Node 24.21), NVIDIA RTX 3060 Laptop GPU.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | **141 tests passed** (16 files, about 24 s) |
| `npm run test:e2e` (built app) | **18 passed** (about 3.4 min) |
| E2E on the packaged `MyCluely.exe` | **18 passed** (about 3.4 min) |
| On-device Whisper E2E | **Passed**: 1.9 min on the first run (includes the model download); about 15–18 s with the model cached (app launch + ~6 s of speech + model initialisation + inference). The transcript was word-for-word correct and ran on WebGPU. |
| `npm run package` | `MyCluely-Setup-1.0.9.exe` (NSIS, 122.0 MB) and `MyCluely-1.0.9-portable.exe` (121.8 MB) built (unsigned). |
| OCR on a real desktop (local check, 1920×1080) | Old pipeline: mean confidence 75% (borderline), 1.9 s. New pipeline: 61 of 340 junk words dropped, 86% of text read confidently → *clear*, 1.4 s. |

### ChatGPT plan (Sign in with ChatGPT)

Verified against a local mock of OpenAI's documented flow (`tests/helpers/mock-chatgpt.ts`): discovery, dynamic client registration, PKCE, RS256 ID-token verification (a token signed by another key is rejected), consent denied / plan usage not granted, refresh with rotation (single refresh for concurrent callers), invalid refresh grant → signed out, revocation, model listing, streaming answers with `store: false`, image-unsupported fallback, usage-limit / not-eligible / invalid-user codes, and the full UI flow in the real app (`tests/e2e/chatgpt.spec.ts`). **Verified live on 2026-10-08** with a real ChatGPT account in the 1.0.2 build: sign-in succeeded and answers streamed through the plan (`gpt-5.6-luna`).

### Real provider APIs

Run on 2026-10-08 with keys the user entered into a test build of the app:

| Provider | Verified live | Result |
| --- | --- | --- |
| **Anthropic** | Connection test / model listing; streamed *Answer*, *Explain this screen* (with screenshot), *Ask*, *Summarize* with `claude-opus-5-5` | All succeeded. The Models API listed 14 chat models including `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1`. The slide was read correctly from the image + OCR, and answers stated "no transcript yet" when appropriate. |
| **Google Gemini** | Connection test / model listing; streamed *Answer*, *Ask*, *Summarize* with `gemini-3.8-flash`; transcription with `gemini-3.5-flash-lite` | All succeeded; 19 chat models listed. Transcription of the TTS question was exact. In one run the API returned HTTP 503 (overloaded) on every attempt; the next run succeeded after the built-in retries. |
| **OpenAI** | Not verified live (no key available) | Implemented to the official Responses and Audio Transcriptions API references; verified against the mock server for request shape, streaming events, parameter fallback, auth errors, cancellation and diarized output. |
| **Moonshot (Kimi)** | Not verified live (no key available) | Implemented to the official Kimi API docs; verified against the mock server, including the model-list capability fields, chat-completions streaming, the absence of sampling params, and K2.6 `thinking` / K3 `reasoning_effort`. |
| **DeepSeek** | Not verified live (no key available) | Implemented to the official DeepSeek API docs; verified against the mock server (model list with `input_modalities`/`context_window`, streaming with hidden `reasoning_content`, `thinking` on/off and `reasoning_effort`, image-rejection fallback) and end to end in the app (`tests/e2e/deepseek.spec.ts`). |

To verify OpenAI, Kimi or DeepSeek yourself:
1. Add the key in *Settings → API keys & providers* and click **Test connection**. This lists models and flags the selected model if it is missing.
2. Select the provider, start a meeting, and use **Answer** and **Explain screen**.
3. For OpenAI transcription, set *Transcription → Engine → OpenAI*.

## Manual checks for a real meeting

These need a human in a real call and cannot be automated here:

1. **Teams, Zoom or Google Meet:**
   - Join a test call with headphones.
   - Start MyCluely and confirm the *Meeting audio* meter moves when the other person speaks and their lines appear as **Remote**.
   - Confirm your own speech appears as **You**.
2. **Speakers instead of headphones.** Confirm remote speech is not duplicated as "You" (echo filter); a few duplicates are possible.
3. **Region capture.** Click **Region**, drag over a slide, click **Capture**; only that area should be read.
4. **Window capture.** Pick the meeting's shared-content window and use **Explain screen**. Minimise the window and confirm a "blank capture" note.
5. **Device change.** Unplug or switch the microphone during a meeting. Capture should reconnect, or fall back to the default device with a status message.
6. **Global shortcuts.** Use `Ctrl+Alt+Enter` while the meeting app is focused; the panel should show the answer.
7. **Long meeting.** Run for 60+ minutes. The transcript stays responsive, pending transcription stays near 0, and answers still reference early topics (rolling summary).
