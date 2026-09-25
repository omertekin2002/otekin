# `npx otekin`

A tiny terminal profile CLI with generic AI chat.

## Run

```bash
npx otekin
npx otekin cv
npx otekin linkedin
```

## AI chat

No API key or additional package is required. Ask a one-shot question, start an interactive conversation, or open chat through the profile menu:

```bash
npx otekin chat "What happened today?"
npx otekin chat "What happened today?" --research always
npx otekin chat "Rewrite this paragraph" --research never
npx otekin chat
npx otekin chat "Explain this" --json
npx otekin --select chat
```

Interactive chat keeps context in memory for the current CLI process. Use these commands at the `You:` prompt:

- `/clear` clears the conversation history.
- `/exit` or `/quit` ends the session.
- Ctrl+C also ends the session.

Blank input simply displays the prompt again. Chat requests are non-streaming. The service can take several model and tool steps before answering, and the CLI allows up to five minutes per chat request after waking the service.

Research defaults to `auto`: the answering model decides when to search, read pages or PDFs, or fetch public API data. Search results are leads; the model opens sources before citing them. Use `--research always` to require fresh source text fetched during each turn, or `--research never` to disable those research tools. The selected mode also applies to every turn of an interactive chat session. Fresh retrieval does not guarantee that every claim is supported.

Before each chat request, the CLI calls the service's lightweight `GET /healthz` route. This wakes an idle Render free-plan instance before any conversation content is sent. The health check does not invoke research or model providers; a cold start can still take around a minute, and interactive terminals show a brief wake-up notice when it is slow.

Research citations are shown as a compact source row instead of raw redirect URLs. In supported terminals, each numbered source label is clickable. Use `--json` when you need the complete source URLs, snippets, and gateway metadata.

Interactive history retains the gateway's bounded tool results and source catalog so follow-up questions can use the same evidence and source numbers. Older complete turns are trimmed to stay within the service's character and request-byte limits.

When the service has optional image generation enabled, ask for an image in the same chat. Normal output saves generated images as PNG files in a temporary `otekin-images-*` directory and prints their paths. These files remain until you or the operating system removes them. `--json` preserves the inline image data without writing files. Image bytes are replaced with text placeholders in conversation history.

## Options

- `--non-interactive`: print the profile message and links without a prompt.
- `--no-open`: print a selected URL instead of opening it in a browser.
- `--cv`, `--resume`: open the CV link directly.
- `--select <website|linkedin|cv|chat|exit>`: skip the menu and choose an option.
- `--json`: output profile JSON, or preserve the complete response object for a one-shot chat.
- `--research <auto|always|never>`: control grounded research for one-shot or interactive chat; defaults to `auto`.
- `--help`, `--version`: print CLI help or the package version.

## Examples

```bash
npx otekin --non-interactive
npx otekin cv
npx otekin linkedin
npx otekin --cv
npx otekin --select website --no-open
npx otekin --select cv --no-open
npx otekin chat "Explain quantum computing simply"
npx otekin chat "Find sources on recent EU AI Act changes" --research always
npx otekin chat "Rewrite this sentence" --research never
npx otekin --json chat "What changed recently in EU AI regulation?"
```

## Chat service and privacy

Chat uses the public SLgateway endpoint and requires no API key. In the default `auto` mode, the model chooses its research tools and can continue after a tool failure. `always` requires fresh retrieval during the current turn, while `never` disables research tools. Conversation history, including tool replay and source catalogs, is stored only in CLI memory; bounded history is sent again on subsequent turns. Generated image files are saved separately as described above. The CLI accepts responses up to 24 MiB to accommodate optional images.

Conversation content is transmitted to SLgateway and its configured model providers. Tool use can send search queries to search providers, URLs to hosted readers, requests to public API targets, and image prompts to the image provider. Calling the public endpoint can consume those providers' resources. Do not send sensitive content you would not want processed by those services.

When the gateway returns a safe structured failure, the CLI shows a specific category and its request ID. The request ID can be used to correlate server logs without exposing provider responses or credentials.

For local development or testing, override the non-secret endpoint:

```bash
OTEKIN_CHAT_API_URL=http://localhost:10000/v1/chat npx otekin chat "Hello"
```

The health URL defaults to `/healthz` on the configured chat endpoint's origin. Override it only when a compatible local service uses a different route:

```bash
OTEKIN_CHAT_API_URL=http://localhost:10000/v1/chat \
OTEKIN_CHAT_HEALTH_URL=http://localhost:10000/ready \
npx otekin chat "Hello"
```

CORS restrictions do not affect this Node.js CLI. The override must use an HTTP or HTTPS URL.
