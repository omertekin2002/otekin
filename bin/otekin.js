#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const pkg = require('../package.json');
const {
  requestChat,
  prepareRequestMessages,
  ensureChatServiceAwake
} = require('../lib/chat-client');
const { formatChatResponse } = require('../lib/chat-format');

const MESSAGE = "Hello! I'm Ömer, I'm a law & business student currently studying at Koç University";
const LINKS = {
  website: 'https://omertekin2002.github.io',
  linkedin: 'https://www.linkedin.com/in/ömer-tekin/',
  cv: 'https://omertekin2002.github.io/resume'
};

function printHelp() {
  const help = `
otekin — terminal profile card

Usage:
  npx otekin
  npx otekin cv
  npx otekin linkedin
  npx otekin chat "What happened today?"
  npx otekin chat

Options:
  -h, --help              Show help
  -v, --version           Show version
  --non-interactive       Print text + links and exit (no prompt)
  --json                  Output profile or one-shot chat JSON and exit
  --no-open               Don't open links in a browser (print them instead)
  --cv, --resume          Open the CV download link directly
  -s, --select <choice>   Skip the prompt and select: website | linkedin | cv | chat | exit

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

Interactive chat commands:
  /clear                   Clear conversation history
  /exit, /quit             End the chat session

Environment:
  OTEKIN_CHAT_API_URL      Override the HTTP(S) chat endpoint (no API key required)
  OTEKIN_CHAT_HEALTH_URL   Override its HTTP(S) health endpoint (defaults to /healthz)
`.trim();

  process.stdout.write(help + '\n');
}

function parseArgs(argv) {
  const opts = {
    help: false,
    version: false,
    nonInteractive: false,
    json: false,
    noOpen: false,
    select: null,
    command: null,
    commandArgs: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--non-interactive' || a === '--no-interactive') opts.nonInteractive = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--cv' || a === '--resume') opts.select = 'cv';
    else if (a === '-s' || a === '--select') {
      opts.select = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith('--select=')) {
      opts.select = a.slice('--select='.length) || null;
    } else if (!a.startsWith('-') && opts.command === 'chat') {
      opts.commandArgs.push(a);
    } else if (!a.startsWith('-') && a.toLowerCase() === 'chat' && !opts.select) {
      opts.command = 'chat';
    } else if (!a.startsWith('-') && !opts.select) {
      opts.select = a;
    }
  }

  return opts;
}

function isInteractiveAllowed(opts) {
  if (opts.nonInteractive) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printNonInteractive() {
  process.stdout.write('Links:\n');
  process.stdout.write(`- Website: ${LINKS.website}\n`);
  process.stdout.write(`- LinkedIn: ${LINKS.linkedin}\n`);
  process.stdout.write(`- CV: ${LINKS.cv}\n`);
}

function safeEncodeUrl(url) {
  try {
    return encodeURI(url);
  } catch {
    return url;
  }
}

function openInBrowser(url) {
  const encoded = safeEncodeUrl(url);
  const platform = process.platform;

  const command = platform === 'darwin'
    ? 'open'
    : platform === 'win32'
      ? 'cmd'
      : 'xdg-open';

  const args = platform === 'win32'
    ? ['/c', 'start', '', encoded]
    : [encoded];

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
    await runInteractiveChat();
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

function hideCursor() {
  try {
    process.stdout.write('\u001B[?25l');
  } catch {}
}

function showCursor() {
  try {
    process.stdout.write('\u001B[?25h');
  } catch {}
}

function restoreTerminal() {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  } catch {}
  showCursor();
}

function writeLine(value) {
  process.stdout.write(String(value).replace(/(?:\r?\n[ \t]*)+$/, '') + '\n');
}

function startProgress(stream, message) {
  if (!stream.isTTY) return () => {};

  let cleared = false;
  stream.write(message);
  return () => {
    if (cleared) return;
    cleared = true;
    readline.clearLine(stream, 0);
    readline.cursorTo(stream, 0);
  };
}

function startDelayedProgress(stream, message, delayMs) {
  if (!stream.isTTY) return () => {};

  let clearProgress = () => {};
  const timer = setTimeout(() => {
    clearProgress = startProgress(stream, message);
  }, delayMs);

  return () => {
    clearTimeout(timer);
    clearProgress();
  };
}

function errorMessage(error) {
  return error && error.message ? String(error.message) : 'Chat request failed.';
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

  const clearWakeProgress = startDelayedProgress(
    process.stderr,
    'AI: waking chat service…',
    750
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

  const clearProgress = startProgress(process.stderr, 'AI: thinking…');
  try {
    const response = await requestChat(messages);
    clearProgress();
    if (opts.json) {
      process.stdout.write(JSON.stringify(response, null, 2) + '\n');
    } else {
      writeLine(formatChatResponse(response, { hyperlinks: Boolean(process.stdout.isTTY) }));
    }
  } catch (error) {
    clearProgress();
    process.stderr.write(`Chat error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function question(rl, prompt) {
  return new Promise((resolve) => {
    let answered = false;
    const onClose = () => {
      if (answered) return;
      answered = true;
      resolve(null);
    };

    rl.once('close', onClose);
    rl.question(prompt, (answer) => {
      if (answered) return;
      answered = true;
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

async function runInteractiveChat() {
  restoreTerminal();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  let history = [];
  let exitRequested = false;
  let activeController = null;

  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    rl.close();
  });
  rl.on('close', () => {
    exitRequested = true;
    if (activeController) activeController.abort();
  });

  process.stdout.write('AI chat — type /clear to reset or /exit to quit.\n\n');

  try {
    while (true) {
      const input = await question(rl, 'You: ');
      if (input === null) break;

      const prompt = input.trim();
      const command = prompt.toLowerCase();
      if (!prompt) continue;
      if (command === '/exit' || command === '/quit') break;
      if (command === '/clear') {
        history = [];
        process.stdout.write('Conversation cleared.\n\n');
        continue;
      }

      let candidate;
      try {
        candidate = prepareRequestMessages(history, prompt);
      } catch (error) {
        process.stderr.write(`AI error: ${errorMessage(error)}\n\n`);
        continue;
      }

      activeController = new AbortController();
      const clearWakeProgress = startDelayedProgress(
        process.stdout,
        'AI: waking chat service…',
        750
      );
      let clearProgress = () => {};
      try {
        await ensureChatServiceAwake({ signal: activeController.signal });
        clearWakeProgress();
        if (exitRequested) break;
        clearProgress = startProgress(process.stdout, 'AI: thinking…');
        const response = await requestChat(candidate, { signal: activeController.signal });
        clearProgress();
        if (exitRequested) break;
        process.stdout.write('AI: ');
        writeLine(formatChatResponse(response, { hyperlinks: Boolean(process.stdout.isTTY) }));
        process.stdout.write('\n');
        history = candidate.concat({ role: 'assistant', content: response.message });
      } catch (error) {
        clearWakeProgress();
        clearProgress();
        if (exitRequested) break;
        process.stderr.write(`AI error: ${errorMessage(error)}\n\n`);
      } finally {
        activeController = null;
      }
    }
  } finally {
    rl.close();
    restoreTerminal();
  }
}

function promptMenu() {
  const choices = [
    { label: 'Personal website', value: 'website' },
    { label: 'LinkedIn', value: 'linkedin' },
    { label: 'Download CV', value: 'cv' },
    { label: 'Chat with AI', value: 'chat' },
    { label: 'Exit', value: 'exit' }
  ];

  return new Promise((resolve) => {
    let selected = 0;
    let renderedLines = 0;

    const input = process.stdin;
    const output = process.stdout;

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    hideCursor();

    const render = () => {
      const lines = [];
      lines.push('Choose an option (↑/↓ + Enter, or 1-5):');
      for (let i = 0; i < choices.length; i += 1) {
        const prefix = i === selected ? '❯' : ' ';
        lines.push(`${prefix} ${choices[i].label}`);
      }
      const out = lines.join('\n') + '\n';

      if (renderedLines > 0) {
        readline.moveCursor(output, 0, -renderedLines);
        readline.cursorTo(output, 0);
        readline.clearScreenDown(output);
      }
      output.write(out);
      renderedLines = lines.length;
    };

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      input.removeListener('keypress', onKeypress);
      try {
        if (input.isTTY) input.setRawMode(false);
      } catch {}
      input.pause();
      showCursor();
    };

    const onKeypress = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        cleanup();
        resolve('exit');
        return;
      }

      if (str === '1' || str === '2' || str === '3' || str === '4' || str === '5') {
        selected = Math.max(0, Math.min(choices.length - 1, Number(str) - 1));
        render();
        cleanup();
        resolve(choices[selected].value);
        return;
      }

      if (!key) return;
      if (key.name === 'up') {
        selected = (selected - 1 + choices.length) % choices.length;
        render();
      } else if (key.name === 'down') {
        selected = (selected + 1) % choices.length;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(choices[selected].value);
      } else if (key.name === 'escape') {
        cleanup();
        resolve('exit');
      }
    };

    // Ensure cursor is restored even if something goes sideways.
    process.once('exit', showCursor);

    render();
    input.on('keypress', onKeypress);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

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

    await runInteractiveChat();
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ message: MESSAGE, links: LINKS }, null, 2) + '\n');
    return;
  }

  process.stdout.write(MESSAGE + '\n\n');

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

  if (!isInteractiveAllowed(opts)) {
    printNonInteractive();
    return;
  }

  const choice = await promptMenu();
  await handleChoice(choice, opts);
}

main().catch((err) => {
  restoreTerminal();
  process.stderr.write((err && err.message) ? String(err.message) + '\n' : 'Unexpected CLI error.\n');
  process.exitCode = 1;
});
