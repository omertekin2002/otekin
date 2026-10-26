# `npx otekin`

A full-screen terminal workspace with AI chat and Ömer Tekin's profile. Built with React and Ink.

Requires **Node.js 22 or newer**.

## Run

```bash
npx otekin
npx otekin cv
npx otekin linkedin
```

In an interactive terminal, `npx otekin` opens a full-screen workspace. A persistent composer stays below the scrollable conversation, with live research activity and a navigation rail on wider terminals. The layout adapts when you resize the window. Exiting restores your previous terminal screen.

Type `/` to open the command picker. Use ↑/↓ to choose a command, Tab to complete it, and Enter to run it. Profile links are also available through the navigation rail; press Tab to focus it, then ↑/↓ and Enter.

| Key | Action |
| --- | --- |
| Enter | Send a message |
| Ctrl+J or Alt+Enter | Add a new line; Shift+Enter also works in supporting terminals |
| ←/→, Home/End | Move the editing cursor |
| ↑/↓ | Move between lines; recall prompts in a single-line draft |
| Ctrl+W, Ctrl+U, Ctrl+K | Delete a word, the draft, or the rest of the line |
| Page Up / Page Down | Scroll while keeping the composer visible |
| Ctrl+Home / Ctrl+End | Jump to the beginning or end of the conversation |
| Esc | Cancel a request or return to the composer |
| Ctrl+C | Cancel a request; exit when idle |
| Ctrl+D | Exit with an empty draft |

You can write your next draft while a reply is in progress. Pasted multiline text stays in the composer until you press Enter. Chat history and previous prompts last for the current session.

Pipes, `TERM=dumb`, and `--non-interactive` use plain profile output. Direct link commands, one-shot chat, and JSON output remain available without entering full-screen mode.

## AI chat

No API key is required. Ask a one-shot question or open the full-screen chat directly:

```bash
npx otekin chat "What happened today?"
npx otekin chat
npx otekin chat "Explain this" --json
npx otekin --select chat
npx otekin chat -- "-5°C in °F?"
```

Prompt words that start with `-` but don't look like an option, such as `-5°C`, are sent as text. Words that look like an option, such as `-x` or `--name`, are rejected as unknown options unless they come after `--`: the CLI prints `Unknown option: --name` and exits with code 1 without sending anything. Everything after `--` is always sent as prompt text, so `npx otekin chat -- --help me` asks about `--help me`.

Use these commands in the composer:

- `/help` shows commands and keyboard shortcuts.
- `/profile` shows Ömer's profile.
- `/website`, `/linkedin`, and `/cv` open profile links. With `--no-open`, they display the URL in the conversation.
- `/clear` clears the conversation history.
- `/exit` or `/quit` ends the session.

Only a single word after `/` runs a command. Other text that starts with a slash, such as `/r/law is debating this`, is sent as a message. To send a single slash word as a message, start it with `//`; for example, `//etc` sends `/etc`.

Each reply is labeled with the name of the model that answered, as reported by the gateway.

Blank input is ignored. In a terminal, chat shows live tool activity: search queries, pages being read, API requests, and image generation. A status line shows the current operation and elapsed time; completed steps remain above the answer, and failed tools are marked explicitly. In the full-screen chat, the reply text appears as it streams in, marked as provisional, with terminal escapes removed and inline image data hidden. When the gateway finishes, it is replaced by the canonical answer with citations and image output. One-shot, piped and `--json` output still print only the final answer. The CLI allows up to five minutes per chat request after the health check succeeds.

The terminal interface uses subtle color, clear speaker labels, and lightweight Markdown styling. Set `NO_COLOR=1` to disable color. Piped output stays plain, and `--json` returns the complete response without progress output. One-shot activity goes to stderr so stdout remains usable in pipelines. JSON and fully redirected requests continue to use the non-streaming endpoint contract. Gateways that return JSON to a streaming request display their completed tool activity after the reply arrives.

Research is automatic: the CLI uses the gateway's default `auto` behavior, in which the answering model decides when to search, read pages or PDFs, or fetch public API data. Search results are leads; the model opens sources before citing them. Fresh retrieval does not guarantee that every claim is supported.

Before each chat request, the CLI calls the service's lightweight `GET /healthz` route to check that the service is ready before sending any conversation content. By default, this is `https://signloop-chat-api.vercel.app/healthz`. The health check does not invoke research or model providers. Interactive terminals show a brief wake-up notice if the check is slow.

Research citations are shown as a compact source row instead of raw redirect URLs. Source labels preserve the gateway's stable citation numbers, so gaps can remain as older sources retire. In supported terminals, each numbered source label is clickable. Use `--json` when you need the complete source URLs, snippets, and gateway metadata.

Interactive history retains the gateway's bounded tool results and source catalog so follow-up questions can use the same evidence and source numbers. Older complete turns are trimmed to stay within the service's character and request-byte limits.

When the service has optional image generation enabled, ask for an image in the same chat. Normal output saves generated images as PNG files in a temporary `otekin-images-*` directory and prints their paths. These files remain until you or the operating system removes them. `--json` preserves the inline image data without writing files. Image bytes are replaced with text placeholders in conversation history.

## Options

- `--non-interactive`: print the profile message and links without a prompt.
- `--no-open`: print a selected URL instead of opening it in a browser.
- `--cv`, `--resume`: open the CV link directly.
- `--select <website|linkedin|cv|chat|exit>`: choose an option directly.
- `--json`: output profile JSON, or preserve the complete response object for a one-shot chat.
- `--help`, `--version`: print CLI help or the package version.
- `--`: end options. Later arguments are prompt text after `chat`, or a choice such as `cv`.

Any other option, before or after `chat`, is an error: the CLI exits with code 1 and names the unknown option.

## Examples

```bash
npx otekin --non-interactive
npx otekin cv
npx otekin linkedin
npx otekin --cv
npx otekin --select website --no-open
npx otekin --select cv --no-open
npx otekin chat "Explain quantum computing simply"
npx otekin chat "Find sources on recent EU AI Act changes"
npx otekin --json chat "What changed recently in EU AI regulation?"
```

## Chat service and privacy

Chat uses the public SLgateway endpoint at `https://signloop-chat-api.vercel.app/v1/chat`, hosted on Vercel, and requires no API key. The model chooses its research tools and can continue after a tool failure. Conversation history, including tool replay and source catalogs, is stored only in CLI memory; bounded history is sent again on subsequent turns. Generated image files are saved separately as described above. The CLI accepts responses up to 24 MiB to accommodate optional images. Streaming transfers are capped at 48 MiB because image data can appear in both a provisional delta and the final reply; each individual event remains limited to 24 MiB.

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

## Develop locally

```bash
npm ci
npm start
npm test
```

`npm start` opens the local version in your terminal. The terminal tests use a headless xterm emulator to check the actual rendered screen, keyboard input, resizing, scrolling, and cleanup.
