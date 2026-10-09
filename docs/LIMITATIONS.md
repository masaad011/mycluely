# Known limitations

## Audio and transcription

- **System audio is system-wide.** Windows loopback capture records everything your PC plays (meeting app, notifications, music), not a single app. Mute other media during meetings. Per-app capture would need the native WASAPI process-loopback API, which is not available in Electron today.
- **Speaker identification is per channel:**
  - "You" means your microphone; "Remote" means everyone else.
  - With *Separate remote speakers* (OpenAI only), meeting audio is split into "Remote A/B…" within each segment, but labels are not stable across the meeting.
  - There is no voice enrolment or participant naming.
- **Echo without headphones.** If you use speakers, your microphone hears the other participants too. MyCluely drops microphone lines that match recent remote speech, but some duplicates can remain (and a genuine repeat can occasionally be dropped). Headphones work best.
- **Transcripts arrive per utterance, not word by word.** Speech is sent when the speaker pauses (0.7 s by default) or after 14 s of continuous speech, so text lags speech by roughly a pause plus processing time. Real-time streaming speech APIs are not used.
- **On-device Whisper:**
  - The first use downloads the model (about 80–250 MB) from Hugging Face, so it needs internet once.
  - The default `whisper-base.en` is English-only; choose `whisper-base` or a cloud engine for other languages.
  - Accuracy is below the cloud models, and it is noticeably slower on machines without a WebGPU-capable GPU.
- **Gemini transcription** uses general Gemini models through `generateContent`. Google's dedicated `gemini-3.5-transcribe` model (Interactions API) is not used yet. Gemini can return HTTP 503 under load; MyCluely retries but does not switch engines when you picked Gemini explicitly. *Auto* mode falls back to on-device Whisper only on permanent errors.
- **Question detection is heuristic and tuned for English phrasing.** It can miss implicit questions or flag rhetorical ones.
- **Auto mode on the screen:**
  - It watches only while a meeting is running, and only the selected screen, window or region — select a region or the relevant window to avoid answering unrelated parts of the screen.
  - A local check decides whether readable text looks like it needs an answer (questions, tasks, problem statements, options, errors; English phrasing). Screens that plainly need no answer are not sent; borderline ones are, and the model may reply that there is nothing to answer (nothing is shown then).
  - A new item in a long, otherwise unchanged screen (e.g. a chat) needs at least four new words to count as new.
  - Each automatic screen answer is a model request with the screenshot (vision models), so it uses API credits; reading a full 4K screen with OCR also takes CPU — a window or region is lighter.

## Screen

- **OCR is English only.** Other scripts and handwriting depend on a vision-capable model receiving the screenshot.
- **Small, low-contrast or stylised text may be misread.** The readability rating and notes flag this.
- **Region capture works on screens, not on individual windows.** Pick a window as the source to capture just that window.
- **Some content comes out black:** minimised windows, DRM-protected video, and apps that exclude themselves from capture. MyCluely reports this as a blank or unreadable capture.
- **Capture history is capped.** At most 300 screen captures are kept per meeting; older captures are dropped from the meeting record.

## AI providers

- **ChatGPT plan** covers answers only (not transcription), is subject to your plan's usage limits (shared with Codex), and relies on OpenAI's *Sign in with ChatGPT* availability for open-source/local apps. Some request features (e.g. screenshots) may not be accepted under plan usage; MyCluely then falls back to screen text. Sign-in and answers were verified with a real account on 2026-10-08; error paths (usage limits, ineligible plans) were verified only against a mock. Sign-in needs local port 1455 free.
- **Claude, Gemini-app and Kimi subscriptions can't be used** — those providers don't allow third-party apps to use consumer plans; an API key (or Gemini's free tier) is required. **DeepSeek has no subscription** (free chat app, prepaid API), so it always needs an API key.

- **Not verified against live APIs:** OpenAI, Moonshot (Kimi) and DeepSeek were tested only against wire-compatible mock servers (no keys were available). Anthropic and Google Gemini were verified live on 2026-10-08. See [TESTING.md](TESTING.md).
- **OpenAI capability detection is a guess.** OpenAI's model list carries no capability metadata, so image support is inferred from the model name. You can override it per model in *Settings → AI model*.
- **Older or unusual models** may reject parameters (reasoning effort, thinking level, refusal fallback). MyCluely removes the parameter and retries, but some other incompatibilities may still surface as errors.
- **No local LLM.** Answers always come from a cloud provider; offline use is limited to transcription and OCR.
- **Provider data handling** follows each provider's API terms. Meeting content you send leaves your machine.

## Desktop and platform

- **Windows only for now.** macOS is designed for but not built or tested (see the roadmap in [ARCHITECTURE.md](ARCHITECTURE.md)).
- **The build is unsigned** (SmartScreen warning on first run) and has no auto-update.
- **Global shortcuts can collide with other apps.** Collisions are reported, and shortcuts are configurable. The defaults use `Ctrl+Alt+Space`, `Ctrl+Alt+Enter` and `Ctrl+Alt+Shift+…`, and action shortcuts are active only during a meeting.
- **"Hide from capture"** relies on Windows 10 2004+ display affinity; some legacy capture tools may ignore it.
- **Fonts** in *Settings → Appearance* are the ones that ship with Windows; if one is missing (e.g. Cascadia on older Windows 10) the next available font is used.
- **The UI is English-only.** There is one meeting at a time; history has no full-text search; export is Markdown or text (no PDF/DOCX).
- **Meeting history is not encrypted.** It is plain JSON in your Windows profile, protected by your account permissions. API keys *are* encrypted.
