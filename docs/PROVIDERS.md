# AI providers: setup, billing and models

MyCluely talks to each provider through its **official API and SDK**. You bring your own API key; each provider bills you directly.

> **API billing is separate from consumer subscriptions** — with one exception: a **ChatGPT Plus/Pro plan** can be connected directly (“Continue with ChatGPT”), so answers count against your plan instead of API billing. Claude Pro/Max, the Gemini app (Google AI Pro/Ultra) and the Kimi membership can’t be used by other apps, and DeepSeek has no subscription at all; they need an API key from the developer platforms below.

## Using a subscription instead of API charges

| Subscription | In MyCluely | Details |
| --- | --- | --- |
| **ChatGPT Plus / Pro** | **Yes — “Continue with ChatGPT”** | OpenAI’s official [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart) plan usage, available to open-source and local personal apps. Answers are paid from your plan’s allowance (the same pool Codex uses); you can cap MyCluely’s share and see usage at <https://chatgpt.com/settings/usage>. Answers only — transcription uses on-device Whisper or another engine. |
| **Claude Pro / Max** | No | Anthropic restricts subscription sign-in to its own apps (claude.ai, Claude Code); third-party use violates its consumer terms. Use a Claude API key. |
| **Gemini app (Google AI Pro / Ultra)** | Not directly | Plan benefits apply only in the AI Studio website ([Google AI plans](https://ai.google.dev/gemini-api/docs/google-ai-plans)). Instead use a **free-tier Gemini API key** (rate-limited; free-tier prompts may be used by Google), and Pro/Ultra subscribers can claim monthly Google Cloud credits that apply to Gemini API usage. |
| **Kimi membership / Kimi Code** | No | Kimi Code keys are intended for coding tools ([community guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html)); use a Kimi Open Platform key (minimum $1 recharge). |
| **DeepSeek** | No subscription exists | DeepSeek’s chat app is free and its API is prepaid pay-as-you-go; there is no paid plan to connect. Third-party “DeepSeek plans” are resellers, not DeepSeek. Use a DeepSeek API key — prices are very low (see below). |

### ChatGPT plan: how it works

1. *Settings → API keys & providers → ChatGPT plan → Continue with ChatGPT* opens your browser at `auth.openai.com`.
2. Sign in, choose the workspace and approve **“Use your ChatGPT plan”**. The browser returns to MyCluely through a one-time local address (`http://127.0.0.1:1455/auth/callback`), protected with PKCE and a random state.
3. MyCluely verifies the sign-in token against OpenAI’s published keys, stores the session encrypted with Windows DPAPI, refreshes it automatically, and revokes it when you sign out.
4. Choose **ChatGPT plan** as the provider (automatic if your selected provider has no key). Models are listed live for your account.

Messages you may see: *usage limit reached* (wait for the reset or raise MyCluely’s share in ChatGPT settings), *plan can’t be used in apps* (Plus or Pro required, or your workspace disallows it), *sign in again* (the connection was revoked or expired). If port 1455 is busy (another app signing in with ChatGPT, e.g. Codex), close it and retry. You can disconnect MyCluely any time in ChatGPT settings.

Model information below was checked against the official documentation on **2026-10-08**. MyCluely does **not** depend on these names: the model picker is filled live from each provider's model-list endpoint, and you can type any model ID the provider supports.

## Overview

| | OpenAI | Anthropic | Google Gemini | Moonshot AI (Kimi) | DeepSeek |
| --- | --- | --- | --- | --- | --- |
| API used | Responses API (`POST /v1/responses`) | Messages API (`POST /v1/messages`) | Gemini API `generateContent` (streaming) | Chat Completions (official OpenAI-compatible endpoint) | Chat Completions (official OpenAI-compatible endpoint) |
| SDK | `openai` 7.x | `@anthropic-ai/sdk` 0.132 | `@google/genai` 2.x | `openai` 7.x with Kimi base URL | `openai` 7.x with DeepSeek base URL |
| Default model in MyCluely | `gpt-6.1-sol` | `claude-opus-5-5` | `gemini-3.8-flash` | `kimi-k2.6` | `deepseek-flash` |
| Model list source | `GET /v1/models` | Models API (with context window and capabilities) | `models.list` (with token limits) | `GET /v1/models` (with `context_length`, `supports_image_in`) | `GET /models` (with `context_window`, `input_modalities`) |
| Screenshots (vision) | Current GPT models: yes | From Models API metadata | Yes (multimodal) | From model list metadata | From model list metadata (Flash: yes, V4-Pro: no) |
| Speech-to-text | Yes: `gpt-transcribe` (default), `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`, `gpt-4o-transcribe-diarize` | No | Yes: audio input to any Gemini model (default `gemini-3.5-flash-lite`) | No | No |
| Data handling | Requests sent with `store: false` | Standard API terms | Standard API terms — check free vs. paid tier terms | Standard API terms | Standard API terms |

If you choose Anthropic, Moonshot or DeepSeek for answers, transcription uses on-device Whisper, or OpenAI/Gemini if you also add one of those keys. *Transcription → Auto* chooses for you.

## OpenAI

1. Create an account at <https://platform.openai.com>, add a payment method or credits under **Billing** (<https://platform.openai.com/account/billing/overview>).
2. Create a key at <https://platform.openai.com/api-keys> and paste it into **Settings → API keys & providers → OpenAI**.
3. Pricing: <https://developers.openai.com/api/docs/pricing>.

Current models (official models page, 2026-10-08), all with text + image input and a 1.05M-token context:

| Model | Tier | Notes |
| --- | --- | --- |
| `gpt-6.1-sol` | balanced (default) | Good quality/latency trade-off. |
| `gpt-6-luna` | fast / cheapest | Lowest latency; good for live answers. |
| `gpt-6-astra` | flagship | Highest quality, highest cost. |

How MyCluely calls OpenAI:
- System instructions go in `instructions` and screenshots are `input_image` data URLs; `store: false` is set.
- Reasoning effort is `low` for short/conversational answers and `medium` for detailed/technical ones. It is removed automatically for models that reject the parameter, and no `temperature` is sent (reasoning models reject it).
- Transcription uploads 16 kHz mono WAV segments (well below the 25 MB limit). *Settings → Transcription → Separate remote speakers* uses `gpt-4o-transcribe-diarize` on meeting audio.

## Anthropic (Claude)

1. Sign in at <https://platform.claude.com>, add credits under **Settings → Billing** (<https://platform.claude.com/settings/billing>).
2. Create a key at <https://platform.claude.com/settings/keys>.
3. Pricing: <https://platform.claude.com/docs/en/about-claude/pricing>.

Current models (Claude API, 2026-10-08):

| Model | Notes |
| --- | --- |
| `claude-opus-5-5` | Default. Most capable Opus; 1M context; image input. |
| `claude-sonnet-5-5` | Faster and cheaper; 1M context. |
| `claude-haiku-5-5` | Fastest and cheapest; good for live answers. |
| `claude-fable-5-1` | Anthropic's most capable model, highest cost. |

How MyCluely calls Claude:
- **Capabilities:** vision, effort support and the context window come from the Models API, so new Claude models work without code changes.
- **Effort and thinking:** `output_config.effort` (`low` or `medium`) controls latency where supported. Thinking is left at each model's default (adaptive on current models), and `max_tokens` includes headroom for it.
- **Refusals:** on models that support it, the server-side refusal fallback is enabled (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). If a request is declined for safety reasons, Anthropic retries it on its recommended fallback model and the answer is marked "Answered by fallback model …". It is disabled automatically if the API rejects it. A final `refusal` stop reason is shown as a note.
- **Speech:** Anthropic has no speech-to-text API.

## Google Gemini

1. Open Google AI Studio and create a key at <https://aistudio.google.com/api-keys>.
2. New keys start on the **free tier**, which is rate-limited. Google's Gemini API terms treat free-tier and paid-tier data differently (historically, free-tier prompts may be used to improve Google products) — review the current terms before sending meeting content, and prefer the paid tier by linking a Cloud Billing account at <https://aistudio.google.com/billing>.
3. Pricing: <https://ai.google.dev/gemini-api/docs/pricing>.

Current models (2026-10-08), with about 1M input tokens and text/image/audio/video/PDF input:

| Model | Notes |
| --- | --- |
| `gemini-3.8-flash` | Default for answers; stable. |
| `gemini-3.5-flash-lite` | Fastest and cheapest; default for transcription. |
| `gemini-3.1-pro-preview` | Most capable (preview). |

How MyCluely calls Gemini:
- `generateContentStream` with `systemInstruction` and inline JPEG screenshots.
- **Thinking level:** Gemini 3 thinking is set with `thinkingLevel` (`LOW`/`MEDIUM` for answers, `MINIMAL` for transcription). The lowest accepted level differs by model, so MyCluely steps down automatically when one is rejected. Sampling parameters are not sent.
- **Transcription:** inline 16 kHz WAV with a strict "verbatim transcript only" instruction. Google's dedicated `gemini-3.5-transcribe` model is documented only for the newer Interactions API, so MyCluely uses general Gemini models for transcription.
- **Transient errors:** Gemini can return HTTP 503 ("overloaded") under load. Transcription retries with back-off; switch the transcription model or engine if it persists.

## Moonshot AI (Kimi)

1. Sign up at <https://platform.kimi.ai> (China: <https://platform.kimi.com>) and recharge (minimum $1) under **Console → Account**.
2. Create a key at <https://platform.kimi.ai/console/api-keys>. Keys from the international and China platforms are **not** interchangeable: choose the matching platform under *Settings → Moonshot → Advanced* (`api.moonshot.ai` vs `api.moonshot.cn`).
3. Pricing: <https://platform.kimi.ai/docs/pricing/chat>.

Current models (2026-10-08). All `moonshot-v1-*`, `kimi-latest` and older `kimi-k2*` models are discontinued.

| Model | Context | Notes |
| --- | --- | --- |
| `kimi-k2.6` | 262K | Default. Image input; thinking can be switched off for fast answers. |
| `kimi-k3` | 1M | Flagship; always reasons (`reasoning_effort` low/high/max). |

How MyCluely calls Kimi:
- Uses the OpenAI SDK with Kimi's base URL, as Moonshot's documentation recommends. Screenshots are sent as base64 `image_url` parts.
- **Reasoning:** for K2.x, `thinking` is disabled for short answers and enabled for detailed ones; K3 uses `reasoning_effort` `low` or `high`.
- **Sampling parameters:** Kimi fixes `temperature`/`top_p`/penalties and rejects other values, so MyCluely never sends them.
- **New tier limits:** new accounts start at a low rate tier (3 requests/minute at the $1 tier), so add credit if you see rate-limit messages.

## DeepSeek

1. Sign up at <https://platform.deepseek.com> and top up your balance (the API is prepaid; there is no subscription).
2. Create a key at <https://platform.deepseek.com/api_keys>.
3. Pricing: <https://api-docs.deepseek.com/quick_start/pricing>.

Current models (2026-10-08, from DeepSeek's API docs):

| Model | Context | Notes |
| --- | --- | --- |
| `deepseek-flash` | 1M | Default. DeepSeek-V4.1-Flash; reads screenshots; up to 384K output tokens. |
| `deepseek-v4-pro` | 1M | DeepSeek-V4-Pro; stronger reasoning, text only (MyCluely sends the screen as OCR text). |

The older ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted and served by V4.1-Flash.

Prices per million tokens (off-peak / peak; peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday):

| Model | Input (cache hit) | Input (cache miss) | Output |
| --- | --- | --- | --- |
| `deepseek-flash` | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 |
| `deepseek-v4-pro` | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

How MyCluely calls DeepSeek:
- Uses the OpenAI SDK with DeepSeek's base URL (`https://api.deepseek.com`), as DeepSeek's documentation describes. Screenshots are sent as base64 `image_url` parts to models that accept images.
- **Thinking:** DeepSeek models think by default. Short answers send `thinking: {"type": "disabled"}` for speed; detailed and technical answers keep thinking on with `reasoning_effort: "low"`. The reasoning text (`reasoning_content`) is never shown.
- **Fallbacks:** if a model rejects screenshots, MyCluely retries with screen text and says so; if a model rejects the thinking parameters, it retries without them.
- **Sampling parameters** are not sent (DeepSeek ignores them in thinking mode).

## Choosing models for live meetings

- **Latency matters most.** For live answers prefer fast tiers (`gpt-6-luna`, `claude-haiku-5-5`, `gemini-3.5-flash-lite`, `kimi-k2.6`, `deepseek-flash`) with the *Short* style, and keep *Settings → AI model → Response speed* on **Fastest**. Switch to a stronger model (or *Balanced*) for summaries or deep technical explanations; you can switch mid-meeting. Each answer card shows how long the first words took, so you can compare.
- **Response speed** maps to each provider's reasoning control. *Fastest*: OpenAI / ChatGPT plan `reasoning.effort` `none` (stepping to `minimal`, then `low`, for models that don't accept it), Gemini `thinkingLevel: MINIMAL`, Claude `effort: low`, Kimi K2.x and DeepSeek thinking off, Kimi K3 `reasoning_effort: low`. *Balanced*: a little more for Short and Conversational answers, `medium`-level thinking for Detailed and Technical ones.
- **Transcription speed** also decides how soon a question appears (and how soon Auto-answer can respond): `gemini-3.5-flash-lite` or on-device Whisper on a GPU transcribe faster than larger models.
- **Cost control:**
  - Use **Answer mode → Manual** when you only need occasional help (questions are highlighted; nothing is sent until you click *Answer*). In **Auto**, screen answers send a screenshot to vision models; pause it (`Ctrl+Alt+Shift+W`) when the screen is not relevant.
  - Keep *Send screenshots* on "Automatic" (screenshots only for *Explain this screen* and hard-to-read screens) or "Only for Explain this screen".
  - Leave *Max context per request* at 24K unless you need more.
  - On-device Whisper makes transcription free.
- **Rough transcription cost per meeting hour:**
  - OpenAI `gpt-transcribe`: about $0.27 (listed at $0.0045 per minute)
  - Gemini Flash-Lite: a few cents (audio is 32 tokens per second)
  - On-device Whisper: free

## Proxies and compatible gateways

Each provider has an optional **Custom base URL** (*Settings → API keys & providers → Advanced*), for corporate proxies or API-compatible gateways. Leave it empty to use the official endpoint. Keys can also be supplied through environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`); a key saved in the app takes precedence.
