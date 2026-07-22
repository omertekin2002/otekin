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
npx otekin chat
npx otekin chat "Explain this" --json
npx otekin --select chat
```

Interactive chat keeps context in memory for the current CLI process. Use these commands at the `You:` prompt:

- `/clear` clears the conversation history.
- `/exit` or `/quit` ends the session.
- Ctrl+C also ends the session.

Blank input simply displays the prompt again. Chat requests are non-streaming, so research-heavy answers may take some time.

Research citations are shown as a compact source row instead of raw redirect URLs. In supported terminals, each numbered source label is clickable. Use `--json` when you need the complete source URLs, snippets, and gateway metadata.

## Options

- `--non-interactive`: print the profile message and links without a prompt.
- `--no-open`: print a selected URL instead of opening it in a browser.
- `--cv`, `--resume`: open the CV link directly.
- `--select <website|linkedin|cv|chat|exit>`: skip the menu and choose an option.
- `--json`: output profile JSON, or preserve the complete response object for a one-shot chat.
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
npx otekin --json chat "What changed recently in EU AI regulation?"
```

## Chat service and privacy

Chat uses the public SLgateway endpoint and requires no API key. The endpoint performs web research for every turn. Conversation history is stored only in CLI memory; the complete bounded history is sent again on subsequent turns so the assistant can preserve context.

Conversation content is transmitted to SLgateway and its configured research and model providers. Calling the public endpoint can consume those providers' resources. Do not send sensitive content you would not want processed by those services.

For local development or testing, override the non-secret endpoint:

```bash
OTEKIN_CHAT_API_URL=http://localhost:10000/v1/chat npx otekin chat "Hello"
```

CORS restrictions do not affect this Node.js CLI. The override must use an HTTP or HTTPS URL.
