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

You can write your next draft while a reply is in progress. Pasted multiline text stays in the composer until you press Enter. The conversation and your previous prompts are saved, so the next full-screen session picks up where you left off; ↑ recalls earlier prompts. Use `/clear` to forget them, or `--no-history` to keep a session off the record. See [Saved chat history](#saved-chat-history).

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
- `/retry` sends your last message again. After a failed or cancelled reply, it sends the same request. After a reply arrived, the new reply replaces it, in the conversation and in what is sent to the gateway on later turns.
- `/save` writes the conversation to a new Markdown file in the current directory, such as `otekin-chat-20261027-141500.md`, and shows its path. It contains your messages and the replies, headed by the model that answered, with numbered sources as Markdown links. Notices, errors and tool activity are left out, and replies restored from saved history have no source links. An existing file is never replaced: a second save in the same second adds a number such as `-2`.
- `/clear` clears the conversation. With saved history on, it also deletes the history file and forgets recalled prompts.
- `/exit` or `/quit` ends the session.

Only a single word after `/` runs a command. Other text that starts with a slash, such as `/r/law is debating this`, is sent as a message. To send a single slash word as a message, start it with `//`; for example, `//etc` sends `/etc`.

Each reply is labeled with the name of the model that answered, as reported by the gateway.

Blank input is ignored. In a terminal, chat shows live tool activity: search queries, pages being read, API requests, and image generation. A status line shows the current operation and elapsed time; completed steps remain above the answer, and failed tools are marked explicitly. In the full-screen chat, the reply text appears as it streams in, marked as provisional, with terminal escapes removed and inline image data hidden. When the gateway finishes, it is replaced by the canonical answer with citations and image output. One-shot, piped and `--json` output still print only the final answer. The CLI allows up to five minutes per chat request after the health check succeeds.

The terminal interface uses subtle color, clear speaker labels, and lightweight Markdown styling. Set `NO_COLOR=1` to disable color. Piped output stays plain, and `--json` returns the complete response without progress output. One-shot activity goes to stderr so stdout remains usable in pipelines. JSON and fully redirected requests continue to use the non-streaming endpoint contract. Gateways that return JSON to a streaming request display their completed tool activity after the reply arrives.

Research is automatic: the CLI uses the gateway's default `auto` behavior, in which the answering model decides when to search, read pages or PDFs, or fetch public API data. Search results are leads; the model opens sources before citing them. Fresh retrieval does not guarantee that every claim is supported.

Before each chat request, the CLI calls the service's lightweight `GET /healthz` route to check that the service is ready before sending any conversation content. By default, this is `https://signloop-chat-api.vercel.app/healthz`. The health check does not invoke research or model providers. Interactive terminals show a brief wake-up notice if the check is slow.

Research citations are shown as a compact source row instead of raw redirect URLs. Source labels preserve the gateway's stable citation numbers, so gaps can remain as older sources retire. In supported terminals, each numbered source label is clickable. Use `--json` when you need the complete source URLs, snippets, and gateway metadata.

Interactive history retains the gateway's bounded tool results and source catalog so follow-up questions can use the same evidence and source numbers, including after a restart. Older complete turns are trimmed to stay within the service's character and request-byte limits.

When the service has optional image generation enabled, ask for an image in the same chat. Normal output saves generated images as PNG files in a temporary `otekin-images-*` directory and prints their paths. These files remain until you or the operating system removes them. `--json` preserves the inline image data without writing files. Image bytes are replaced with text placeholders in conversation history.

## Options

- `--non-interactive`: print the profile message and links without a prompt.
- `--no-open`: print a selected URL instead of opening it in a browser.
- `--no-history`: don't load or save the full-screen chat history for this run. An existing history file is left untouched.
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

Chat uses the public SLgateway endpoint at `https://signloop-chat-api.vercel.app/v1/chat`, hosted on Vercel, and requires no API key. The model chooses its research tools and can continue after a tool failure. Bounded conversation history, including tool replay and source catalogs, is sent again on subsequent turns. The full-screen chat also saves it on your computer, as described below. `/save` writes a separate Markdown copy of the conversation to the current directory, even with saved history off. On macOS and Linux only you can read it, and `/clear` leaves it in place. Generated image files are saved separately as described above. The CLI accepts responses up to 24 MiB to accommodate optional images. Streaming transfers are capped at 48 MiB because image data can appear in both a provisional delta and the final reply; each individual event remains limited to 24 MiB.

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

### Saved chat history

The full-screen chat saves the conversation after each completed reply, so it is still there the next time you open it. One-shot `chat "…"`, `--json` and piped runs never read or write it.

- **What is stored:** the bounded history sent back to the gateway (your messages, its replies, tool replay and the source catalog), the last 100 transcript entries as plain text, and your last 50 prompts. Restored replies lose their color and clickable links. Generated images stay in their own files.
- **Where:** one JSON file, `history.json`, in:
  - Linux and others: `$XDG_STATE_HOME/otekin/`, or `~/.local/state/otekin/` when `XDG_STATE_HOME` isn't set
  - macOS: `~/Library/Application Support/otekin/`
  - Windows: `%LOCALAPPDATA%\otekin\`

  Set `OTEKIN_HISTORY_FILE=/path/to/history.json` to use another file.
- **Permissions:** on macOS and Linux the file is readable only by you (`0600`) and its directory is `0700`. It is written to a temporary file first and then renamed, so an interrupted save never leaves half a file. The file isn't encrypted.
- **Forgetting it:** `/clear` deletes the file. Deleting it yourself works too.
- **Turning it off:** `--no-history` skips loading and saving for one run and leaves any existing file untouched. Set `OTEKIN_NO_HISTORY=1` to turn it off for good. With history off, the conversation lasts only for the current session.

The CLI treats the file as untrusted. A file that is damaged, from another version, or over 2 MiB is ignored and the chat starts empty; terminal control sequences in it are never displayed. If a save fails, the status line says so and the chat keeps working.

## Develop locally

```bash
npm ci
npm start
npm test
```

`npm start` opens the local version in your terminal. The terminal tests use a headless xterm emulator to check the actual rendered screen, keyboard input, resizing, scrolling, and cleanup.
