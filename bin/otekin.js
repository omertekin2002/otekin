#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const pkg = require('../package.json');
const {
  requestChat,
  prepareRequestMessages,
  ensureChatServiceAwake,
  probeChatService,
  assistantMessageFromResponse
} = require('../lib/chat-client');
const { formatChatResponse } = require('../lib/chat-format');
const { saveGeneratedImages } = require('../lib/chat-images');
const { browserCommand } = require('../lib/browser');
const chatHistory = require('../lib/chat-history');
const { historyFileFor } = chatHistory;
const {
  cleanText, chatErrorMessage, chatFailureStage, safeRequestId, createTheme, startProgress, createActivityDisplay, reducedMotionFor,
  stringifyJsonForOutput
} = require('../lib/terminal');
const { createStreamPreview } = require('../lib/stream-preview');
const profile = require('../lib/profile');
const { installPilcrow } = require('../lib/install-pilcrow');
const { startLinearChat, prefersLinearChat } = require('../lib/linear-chat');
const { copyToClipboard } = require('../lib/clipboard');

const outputTheme = createTheme(process.stdout);

const LINKS = profile.links;

/** @param {NodeJS.WritableStream} [stream] */
function printHelp(stream = process.stdout) {
  const help = `
otekin — full-screen terminal workspace & AI chat

Usage:
  npx otekin
  npx otekin cv
  npx otekin linkedin
  npx otekin pilcrow
  npx otekin chat "What happened today?"
  npx otekin chat
  npx otekin chat --linear
  npx otekin chat --status
  npx otekin chat -- "-5°C in °F?"

Options:
  -h, --help              Show help
  -v, --version           Show version
  --non-interactive       Print text + links and exit (no prompt)
  --json                  Output profile or one-shot chat JSON and exit
  --no-open               Don't open links in a browser (print them instead)
  --no-history            Don't load or save chat history this run
  --linear                Chat line by line: no animation, each reply printed once
  --status                With chat: check once whether the chat service is up
  --upgrade               With pilcrow: upgrade an existing installation
  --reduced-motion        Show a static status instead of spinners and timers
  --cv, --resume          Open the CV download link directly
  -s, --select <choice>   Select directly: website | linkedin | cv | chat | exit
  --                      End options; later arguments are prompt text or a choice

Prompt words that look like options, such as -x or --name, are rejected as
unknown options unless they come after --.

Give at most one choice, such as "otekin cv": another word after it, a choice
not in the list, or --select or --cv with chat exits with code 1. With --json,
a valid choice still prints the profile JSON.

Examples:
  npx otekin
  npx otekin cv
  npx otekin linkedin
  npx otekin --non-interactive
  npx otekin --cv
  npx otekin --select website --no-open
  npx otekin chat "Explain quantum computing"
  npx otekin chat "Explain this" --json
  npx otekin --select chat

Interactive terminal (Node.js 22+):
  Enter                    Send a message
  Ctrl+J, Alt+Enter         Insert a newline (Shift+Enter where supported)
  Tab                      Focus navigation / complete a slash command
  Page Up / Page Down      Scroll the conversation
  Esc                      Cancel the current request
  Ctrl+C                   Cancel a request, or exit when idle
  /help                    Show all keyboard shortcuts
  /profile                 About Ömer
  /website, /linkedin, /cv  Open profile links
  /retry                   Send your last message again
  /save                    Save the conversation as a Markdown file
  /copy                    Copy the latest reply and its sources to the clipboard
                           (saved as a Markdown file when no clipboard works)
  /sources                 Show the full titles and links of a reply's sources
  /clear                   Clear the conversation and delete saved history
  /exit, /quit             End the chat session
  //text                   Send a message that starts with /

Environment:
  NO_COLOR                Disable terminal colors
  OTEKIN_CHAT_API_URL      Override the HTTP(S) chat endpoint (no API key required)
  OTEKIN_CHAT_HEALTH_URL   Override its HTTP(S) health endpoint (defaults to /healthz)
  OTEKIN_NO_HISTORY=1      Never load or save chat history
  OTEKIN_HISTORY_FILE      Save chat history to this file instead
  OTEKIN_REDUCED_MOTION=1  Same as --reduced-motion (0 or empty leaves motion on)

In a terminal, one-shot chat shows the reply as it streams in, then replaces it
with the final answer. Ctrl+C cancels it and exits with code 130. Piped, --json
and TERM=dumb output print only the final answer.

Linear chat (otekin chat --linear) reads one question per line, from the keyboard
or piped input, and prints each finished reply once, with numbered sources and
their URLs. It never redraws or animates. /last prints the latest reply again,
without the network. /retry sends the last message again, /save writes the
conversation to a Markdown file, and /copy copies the latest reply (or saves it
to a file when no clipboard works). /clear forgets the conversation. Ctrl+C
cancels a reply; Ctrl+C or Ctrl+D when idle, /exit or /quit ends it. A
promptless "otekin chat" on a TERM=dumb terminal opens it automatically.

Reduced motion (--reduced-motion or OTEKIN_REDUCED_MOTION=1) keeps the full-screen
workspace and one-shot chat still: the status shows "… <what is happening>" with
no spinner or seconds counter and changes only when that text does, and streamed
text is redrawn at most once a second. Linear chat never animates anyway.

otekin chat --status asks the chat service's health route once whether it is up,
without sending a question: no conversation content, and no research or model
providers. It prints one line, such as "Chat service: reachable
(signloop-chat-api.vercel.app, 0.4 s)", or with --json one object with status,
endpoint, httpStatus, requestId, elapsedMs and message. The status is reachable,
waking (HTTP 502, 503 or 504: it may be waking up, or failing) or unavailable
(anything else, including no answer within 10 s). It never retries. Exit code 0
means reachable, 1 anything else; Ctrl+C cancels it with exit code 130.

The full-screen and linear chats save their conversation and recent prompts in
one file, so either picks up where the other left off; /clear deletes it.
One-shot, --json and piped chat (including piped linear chat) never read or
write it.
`.trim();

  stream.write(help + '\n');
}

const OPTION_SHAPE = /^--?[A-Za-z][^\s=]*(=.*)?$/;

function printPilcrowHelp() {
  process.stdout.write(`Usage: npx otekin pilcrow [--upgrade]

Install Pilcrow, the DOCX companion-file tool, for your user account.
If uv is missing, asks "Install uv? [y/N]" before downloading its installer.
uv installs Python 3.12 when needed. Enter or "n" cancels without installing.
Installs pilcrow-docx from PyPI outside the npx cache and verifies the executable.

Options:
  --upgrade          Upgrade an existing Pilcrow installation
  -h, --help         Show this help without installing anything
  --non-interactive  Install without prompts; uv must already be installed

After installation, run: pilcrow --help
If the executable directory is not on PATH, setup instructions are printed.
`);
}

const CHOICES = 'website, linkedin, cv, chat, exit';
const INTERACTIVE_JSON_ERROR = 'Interactive chat does not support --json. Provide a prompt for one-shot JSON output.\n';

// Drop any `=value` so pasted values are never echoed back, and strip control characters.
function argumentName(arg) {
  return cleanText(String(arg).split('=')[0]);
}

function unknownOptionError(arg) {
  const name = argumentName(arg);
  return `Unknown option: ${name}\n` +
    `Run "otekin --help" to see the options. To send text that starts with "-", put it after "--": otekin chat -- "${name}"`;
}

function unknownChoiceError(value) {
  return `Unknown choice: ${argumentName(value)}\n` +
    `Choose one of: ${CHOICES}. Run "otekin --help" to see the options.`;
}

function unexpectedArgumentError(arg) {
  return `Unexpected argument: ${argumentName(arg)}\n` +
    'Give one choice, such as "otekin cv". Run "otekin --help" to see the options.';
}

function parseArgs(argv) {
  const opts = {
    help: false,
    version: false,
    nonInteractive: false,
    json: false,
    noOpen: false,
    noHistory: false,
    linear: false,
    status: false,
    reducedMotion: false,
    upgrade: false,
    select: null,
    // The option that set `select` (`--select`, `-s`, `--cv` or `--resume`), or null for a positional choice.
    selectOption: null,
    command: null,
    commandArgs: [],
    error: null,
    errorHelp: false
  };
  let optionsEnded = false;
  // The first positional word after a profile choice: nothing would use it, so it is an error.
  let unexpected = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (optionsEnded || !OPTION_SHAPE.test(a)) {
      if (a === '--' && !optionsEnded) optionsEnded = true;
      else if (opts.command) opts.commandArgs.push(a);
      else if (['chat', 'pilcrow'].includes(a.toLowerCase()) && !opts.select) opts.command = a.toLowerCase();
      else if (!opts.select) opts.select = a;
      else if (unexpected === null) unexpected = a;
    } else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--non-interactive' || a === '--no-interactive') opts.nonInteractive = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--no-history') opts.noHistory = true;
    else if (a === '--linear') opts.linear = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--reduced-motion') opts.reducedMotion = true;
    else if (a === '--upgrade') opts.upgrade = true;
    else if (a === '--cv' || a === '--resume') {
      opts.select = 'cv';
      opts.selectOption = a;
    } else if (a === '-s' || a === '--select' || a.startsWith('--select=')) {
      const value = a.startsWith('--select=') ? a.slice('--select='.length) : argv[(i += 1)];
      if (value && value !== '--') {
        opts.select = value;
        opts.selectOption = '--select';
      } else if (!opts.error) {
        opts.error = 'Missing value for --select';
        opts.errorHelp = true;
      }
    } else if (!opts.error) opts.error = unknownOptionError(a);
  }

  if (!opts.error && opts.select && !normalizeSelect(opts.select)) opts.error = unknownChoiceError(opts.select);
  else if (!opts.error && unexpected !== null) opts.error = unexpectedArgumentError(unexpected);

  return opts;
}

function isInteractiveAllowed(opts) {
  if (opts.nonInteractive) return false;
  return Boolean(process.stdin.isTTY && outputTheme.interactive);
}

function printNonInteractive() {
  process.stdout.write('Links:\n');
  process.stdout.write(`- Website: ${LINKS.website}\n`);
  process.stdout.write(`- LinkedIn: ${LINKS.linkedin}\n`);
  process.stdout.write(`- CV: ${LINKS.cv}\n`);
}

/** @returns {Promise<void>} Resolves once the browser process has started. */
function openInBrowser(url) {
  const launch = browserCommand(process.platform, url);
  // Not an http(s) link: callers report it like any other failed open and show the URL instead.
  if (!launch) return Promise.reject(new Error('Not an http(s) link'));
  const { command, args } = launch;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function handleChoice(choice, opts) {
  if (choice === 'exit') return;

  if (choice === 'chat') {
    if (!isInteractiveAllowed(opts)) {
      process.stderr.write('Interactive chat requires a terminal. Use `otekin chat "your question"` for one-shot chat.\n');
      process.exitCode = 1;
      return;
    }
    await runInteractiveChat(opts);
    return;
  }

  const url = LINKS[choice];
  if (!url) return;

  if (opts.noOpen) {
    process.stdout.write(`Link: ${url}\n`);
    return;
  }

  process.stdout.write(`Opening: ${url}\n`);
  try {
    await openInBrowser(url);
  } catch {
    process.stdout.write(`(Could not auto-open. Here it is: ${url})\n`);
  }
}

function normalizeSelect(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'website' || s === 'site') return 'website';
  if (s === '2' || s === 'linkedin' || s === 'li') return 'linkedin';
  if (s === '3' || s === 'cv' || s === 'resume') return 'cv';
  if (s === '4' || s === 'chat' || s === 'ai') return 'chat';
  if (s === '5' || s === 'exit' || s === 'quit' || s === 'q') return 'exit';
  return null;
}

function showCursor() {
  try {
    process.stdout.write('\u001B[?25h');
  } catch {
    // Ignored: the terminal may already be gone while we restore it.
  }
}

function restoreTerminal() {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  } catch {
    // Ignored: the terminal may already be gone while we restore it.
  }
  if (process.stdout.isTTY) showCursor();
}

function writeLine(value) {
  process.stdout.write(String(value).replace(/(?:\r?\n[ \t]*)+$/, '') + '\n');
}

async function runOneShotChat(prompt, opts) {
  let messages;
  try {
    messages = prepareRequestMessages([], prompt);
  } catch (error) {
    process.stderr.write(`Chat error: ${chatErrorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const reducedMotion = reducedMotionFor(opts, process.env);
  const clearWakeProgress = opts.json ? () => {} : startProgress(
    process.stderr,
    'Waking chat service',
    { delayMs: 750, reducedMotion }
  );
  try {
    await ensureChatServiceAwake();
    clearWakeProgress();
  } catch (error) {
    clearWakeProgress();
    // One-shot chat has no composer to type /retry in, so it never offers the hint.
    process.stderr.write(`Chat error: ${chatErrorMessage(error, 'readiness')}\n`);
    process.exitCode = 1;
    return;
  }

  const activity = !opts.json && process.stderr.isTTY ? createActivityDisplay(process.stderr, { reducedMotion }) : null;
  // On a terminal, the reply streams in as a provisional preview under the AI header.
  const preview = !opts.json && outputTheme.interactive
    ? await createStreamPreview(process.stdout, {
      theme: outputTheme,
      reducedMotion,
      startedAt: activity ? activity.startedAt : undefined,
      statusLabel: () => activity && activity.runningLabel(),
      onShow: () => activity && activity.pause()
    })
    : null;
  const controller = new AbortController();
  // Ctrl+C erases the preview and exits with 130; a second Ctrl+C exits at once.
  const onInterrupt = () => {
    if (controller.signal.aborted) {
      preview.clear();
      process.exit(130);
    }
    controller.abort();
  };
  if (preview) process.on('SIGINT', onInterrupt);
  try {
    const response = await requestChat(messages, {
      signal: preview ? controller.signal : undefined,
      onActivity: activity && preview
        ? (event) => preview.around(() => activity.onActivity(event))
        : activity ? activity.onActivity : undefined,
      onDelta: preview ? preview.update : undefined
    });
    if (preview) preview.clear();
    if (activity) activity.finish(response);
    if (opts.json) {
      process.stdout.write(stringifyJsonForOutput(response) + '\n');
    } else {
      if (outputTheme.interactive) process.stdout.write('\n' + outputTheme.strong('  AI') + '\n\n');
      writeLine(formatChatResponse(saveGeneratedImages(response), {
        hyperlinks: outputTheme.interactive,
        color: outputTheme.color
      }));
      if (outputTheme.interactive) process.stdout.write('\n');
    }
  } catch (error) {
    if (preview) preview.clear();
    if (activity) activity.stop();
    if (controller.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    process.stderr.write(`Chat error: ${chatErrorMessage(error, chatFailureStage(error, 'request'))}\n`);
    process.exitCode = 1;
  } finally {
    if (preview) process.removeListener('SIGINT', onInterrupt);
  }
}

// One bounded readiness check: never sends conversation content, never touches saved history.
async function runStatusCheck(opts) {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.on('SIGINT', onInterrupt);
  let result;
  try {
    result = await probeChatService({ signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }

  const report = {
    status: result.status,
    endpoint: result.endpoint,
    httpStatus: result.httpStatus,
    requestId: safeRequestId(result.requestId),
    elapsedMs: result.elapsedMs,
    message: cleanText(result.message)
  };
  process.exitCode = report.status === 'reachable' ? 0 : 1;
  if (opts.json) {
    process.stdout.write(stringifyJsonForOutput(report) + '\n');
    return;
  }

  const details = [];
  if (report.endpoint) details.push(cleanText(new URL(report.endpoint).host));
  details.push(`${(report.elapsedMs / 1000).toFixed(1)} s`);
  if (report.requestId) details.push(`Request ID: ${report.requestId}`);
  const summary = `Chat service: ${report.status} (${details.join(', ')})`;
  process.stdout.write(report.status === 'reachable' ? `${summary}\n` : `${summary}. ${report.message}\n`);
}

// Shares saved history with the full-screen chat when stdin is a terminal; piped sessions never
// touch it. Resolves when the session ends; it always exits 0.
// /save and the /copy fallback write to the current directory.
async function runLinearChat(firstPrompt, opts) {
  const session = startLinearChat({
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    services: { prepareRequestMessages, ensureChatServiceAwake, requestChat, assistantMessageFromResponse },
    firstPrompt,
    saveDirectory: process.cwd(),
    copy: (text) => copyToClipboard(text),
    historyFile: historyFileFor(opts),
    historyStore: chatHistory
  });
  const onInterrupt = () => session.interrupt();
  process.on('SIGINT', onInterrupt);
  try {
    await session.finished;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

async function runInteractiveChat(opts) {
  const { runTerminalApp } = await import('../lib/fullscreen.mjs');
  await runTerminalApp({
    links: LINKS,
    version: pkg.version,
    options: opts,
    openInBrowser,
    historyFile: historyFileFor(opts)
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.error) {
    process.stderr.write(opts.error + '\n');
    if (opts.errorHelp) printHelp(process.stderr);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    if (opts.command === 'pilcrow') printPilcrowHelp();
    else printHelp();
    return;
  }

  if (opts.version) {
    process.stdout.write(String(pkg.version) + '\n');
    return;
  }

  if (opts.command === 'pilcrow') {
    if (opts.commandArgs.length || opts.select || opts.json || opts.noOpen || opts.noHistory || opts.linear ||
        opts.status || opts.reducedMotion) {
      process.stderr.write('Pilcrow installation accepts only --upgrade, --help, --version, and --non-interactive. Run "otekin pilcrow --help".\n');
      process.exitCode = 1;
      return;
    }
    try {
      await installPilcrow({ upgrade: opts.upgrade, nonInteractive: opts.nonInteractive });
    } catch (error) {
      process.stderr.write(`Pilcrow installation failed: ${cleanText(error.message)}\n`);
      process.exitCode = error.exitCode || 1;
    }
    return;
  }

  if (opts.upgrade) {
    process.stderr.write('--upgrade works only with pilcrow. Run "otekin pilcrow --upgrade".\n');
    process.exitCode = 1;
    return;
  }

  if (opts.linear && opts.command !== 'chat') {
    process.stderr.write('--linear works only with chat. Run "otekin chat --linear".\n');
    process.exitCode = 1;
    return;
  }

  if (opts.status && opts.command !== 'chat') {
    process.stderr.write('--status works only with chat. Run "otekin chat --status".\n');
    process.exitCode = 1;
    return;
  }

  // `chat --select chat` keeps working; any other choice would be silently ignored by chat.
  const selected = normalizeSelect(opts.select);
  if (opts.command === 'chat' && selected && selected !== 'chat') {
    const alone = opts.selectOption === '--select' ? `--select ${selected}` : opts.selectOption;
    process.stderr.write(`${opts.selectOption} does not combine with chat. Run "otekin chat" for chat, or "otekin ${alone}" without chat.\n`);
    process.exitCode = 1;
    return;
  }

  if (!opts.command && selected === 'chat' && opts.json) {
    process.stderr.write(INTERACTIVE_JSON_ERROR);
    process.exitCode = 1;
    return;
  }

  if (opts.command === 'chat') {
    const prompt = opts.commandArgs.join(' ').trim();
    if (opts.status) {
      if (opts.linear || prompt) {
        process.stderr.write(`--status does not take ${opts.linear ? '--linear' : 'a prompt'}. Run "otekin chat --status" on its own.\n`);
        process.exitCode = 1;
        return;
      }
      await runStatusCheck(opts);
      return;
    }
    if (opts.linear) {
      if (opts.json) {
        process.stderr.write('Linear chat does not support --json. Provide a prompt without --linear for one-shot JSON output.\n');
        process.exitCode = 1;
        return;
      }
      await runLinearChat(prompt, opts);
      return;
    }

    if (prompt) {
      await runOneShotChat(prompt, opts);
      return;
    }

    if (opts.json) {
      process.stderr.write(INTERACTIVE_JSON_ERROR);
      process.exitCode = 1;
      return;
    }

    if (prefersLinearChat({
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
      term: process.env.TERM,
      nonInteractive: opts.nonInteractive
    })) {
      await runLinearChat('', opts);
      return;
    }

    if (!isInteractiveAllowed(opts)) {
      process.stderr.write('Chat requires a prompt when input is not an interactive terminal.\n');
      process.exitCode = 1;
      return;
    }

    await runInteractiveChat(opts);
    return;
  }

  if (opts.json) {
    process.stdout.write(stringifyJsonForOutput({ message: `${profile.greeting} ${profile.tagline}`, links: LINKS }) + '\n');
    return;
  }

  if (isInteractiveAllowed(opts) && (!selected || selected === 'chat')) {
    await runInteractiveChat(opts);
    return;
  }

  if (outputTheme.interactive) {
    process.stdout.write('\n  ' + outputTheme.strong(profile.name) + outputTheme.muted(' / otekin') + '\n');
    process.stdout.write('  ' + outputTheme.muted(profile.tagline) + '\n\n');
  } else {
    process.stdout.write(`${profile.greeting}\n${profile.tagline}\n\n`);
  }

  // parseArgs has already rejected a choice that normalizeSelect doesn't know.
  if (selected) {
    await handleChoice(selected, opts);
    return;
  }

  printNonInteractive();
}

main().catch((err) => {
  restoreTerminal();
  process.stderr.write((err && err.message) ? String(err.message) + '\n' : 'Unexpected CLI error.\n');
  process.exitCode = 1;
});
