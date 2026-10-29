#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const pkg = require('../package.json');
const {
  requestChat,
  prepareRequestMessages,
  ensureChatServiceAwake
} = require('../lib/chat-client');
const { formatChatResponse } = require('../lib/chat-format');
const { saveGeneratedImages } = require('../lib/chat-images');
const { browserCommand } = require('../lib/browser');
const { historyFileFor } = require('../lib/chat-history');
const { cleanText, createTheme, startProgress, createActivityDisplay } = require('../lib/terminal');
const { createStreamPreview } = require('../lib/stream-preview');
const profile = require('../lib/profile');

const outputTheme = createTheme(process.stdout);

const LINKS = profile.links;

function printHelp(stream = process.stdout) {
  const help = `
otekin — full-screen terminal workspace & AI chat

Usage:
  npx otekin
  npx otekin cv
  npx otekin linkedin
  npx otekin chat "What happened today?"
  npx otekin chat
  npx otekin chat -- "-5°C in °F?"

Options:
  -h, --help              Show help
  -v, --version           Show version
  --non-interactive       Print text + links and exit (no prompt)
  --json                  Output profile or one-shot chat JSON and exit
  --no-open               Don't open links in a browser (print them instead)
  --no-history            Don't load or save full-screen chat history this run
  --cv, --resume          Open the CV download link directly
  -s, --select <choice>   Select directly: website | linkedin | cv | chat | exit
  --                      End options; later arguments are prompt text or a choice

Prompt words that look like options, such as -x or --name, are rejected as
unknown options unless they come after --.

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
  /clear                   Clear the conversation and delete saved history
  /exit, /quit             End the chat session
  //text                   Send a message that starts with /

Environment:
  NO_COLOR                Disable terminal colors
  OTEKIN_CHAT_API_URL      Override the HTTP(S) chat endpoint (no API key required)
  OTEKIN_CHAT_HEALTH_URL   Override its HTTP(S) health endpoint (defaults to /healthz)
  OTEKIN_NO_HISTORY=1      Never load or save full-screen chat history
  OTEKIN_HISTORY_FILE      Save full-screen chat history to this file instead

In a terminal, one-shot chat shows the reply as it streams in, then replaces it
with the final answer. Ctrl+C cancels it and exits with code 130. Piped, --json
and TERM=dumb output print only the final answer.

The full-screen chat saves its conversation and recent prompts so they come back
next time. One-shot, --json and piped chat never read or write it.
`.trim();

  stream.write(help + '\n');
}

const OPTION_SHAPE = /^--?[A-Za-z][^\s=]*(=.*)?$/;

function unknownOptionError(arg) {
  // Drop any `=value` so pasted values are never echoed back.
  const name = cleanText(arg.split('=')[0]);
  return `Unknown option: ${name}\n` +
    `Run "otekin --help" to see the options. To send text that starts with "-", put it after "--": otekin chat -- "${name}"`;
}

function parseArgs(argv) {
  const opts = {
    help: false,
    version: false,
    nonInteractive: false,
    json: false,
    noOpen: false,
    noHistory: false,
    select: null,
    command: null,
    commandArgs: [],
    error: null,
    errorHelp: false
  };
  let optionsEnded = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (optionsEnded || !OPTION_SHAPE.test(a)) {
      if (a === '--' && !optionsEnded) optionsEnded = true;
      else if (opts.command === 'chat') opts.commandArgs.push(a);
      else if (a.toLowerCase() === 'chat' && !opts.select) opts.command = 'chat';
      else if (!opts.select) opts.select = a;
    } else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--non-interactive' || a === '--no-interactive') opts.nonInteractive = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--no-history') opts.noHistory = true;
    else if (a === '--cv' || a === '--resume') opts.select = 'cv';
    else if (a === '-s' || a === '--select' || a.startsWith('--select=')) {
      const value = a.startsWith('--select=') ? a.slice('--select='.length) : argv[(i += 1)];
      if (value && value !== '--') opts.select = value;
      else if (!opts.error) {
        opts.error = 'Missing value for --select';
        opts.errorHelp = true;
      }
    } else if (!opts.error) opts.error = unknownOptionError(a);
  }

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

function openInBrowser(url) {
  const { command, args } = browserCommand(process.platform, url);

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

function errorMessage(error) {
  const message = error && error.message ? cleanText(error.message) : 'Chat request failed.';
  const requestId = error && typeof error.requestId === 'string'
    ? error.requestId.trim()
    : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) return message;
  return `${message} (Request ID: ${requestId})`;
}

async function runOneShotChat(prompt, opts) {
  let messages;
  try {
    messages = prepareRequestMessages([], prompt);
  } catch (error) {
    process.stderr.write(`Chat error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const clearWakeProgress = opts.json ? () => {} : startProgress(
    process.stderr,
    'Waking chat service',
    { delayMs: 750 }
  );
  try {
    await ensureChatServiceAwake();
    clearWakeProgress();
  } catch (error) {
    clearWakeProgress();
    process.stderr.write(`Chat error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const activity = !opts.json && process.stderr.isTTY ? createActivityDisplay(process.stderr) : null;
  // On a terminal, the reply streams in as a provisional preview under the AI header.
  const preview = !opts.json && outputTheme.interactive
    ? await createStreamPreview(process.stdout, {
      theme: outputTheme,
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
      process.stdout.write(JSON.stringify(response, null, 2) + '\n');
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
    process.stderr.write(`Chat error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (preview) process.removeListener('SIGINT', onInterrupt);
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
    printHelp();
    return;
  }

  if (opts.version) {
    process.stdout.write(String(pkg.version) + '\n');
    return;
  }

  if (opts.command === 'chat') {
    const prompt = opts.commandArgs.join(' ').trim();
    if (prompt) {
      await runOneShotChat(prompt, opts);
      return;
    }

    if (opts.json) {
      process.stderr.write('Interactive chat does not support --json. Provide a prompt for one-shot JSON output.\n');
      process.exitCode = 1;
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
    process.stdout.write(JSON.stringify({ message: `${profile.greeting} ${profile.tagline}`, links: LINKS }, null, 2) + '\n');
    return;
  }

  if (isInteractiveAllowed(opts) && (!opts.select || normalizeSelect(opts.select) === 'chat')) {
    await runInteractiveChat(opts);
    return;
  }

  if (outputTheme.interactive) {
    process.stdout.write('\n  ' + outputTheme.strong(profile.name) + outputTheme.muted(' / otekin') + '\n');
    process.stdout.write('  ' + outputTheme.muted(profile.tagline) + '\n\n');
  } else {
    process.stdout.write(`${profile.greeting}\n${profile.tagline}\n\n`);
  }

  const selectedFromFlag = normalizeSelect(opts.select);
  if (opts.select && !selectedFromFlag) {
    process.stderr.write(`Unknown option: ${opts.select}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (selectedFromFlag) {
    await handleChoice(selectedFromFlag, opts);
    return;
  }

  printNonInteractive();
}

main().catch((err) => {
  restoreTerminal();
  process.stderr.write((err && err.message) ? String(err.message) + '\n' : 'Unexpected CLI error.\n');
  process.exitCode = 1;
});
