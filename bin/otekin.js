#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const pkg = require('../package.json');

const MESSAGE = "Hello! I'm Ömer, I'm a law student currently studying at Koç University";
const LINKS = {
  website: 'https://omertekin2002.github.io',
  linkedin: 'https://www.linkedin.com/in/ömer-tekin/'
};

function printHelp() {
  const help = `
otekin — terminal profile card

Usage:
  npx otekin

Options:
  -h, --help              Show help
  -v, --version           Show version
  --non-interactive       Print text + links and exit (no prompt)
  --json                  Output JSON and exit
  --no-open               Don't open links in a browser (print them instead)
  -s, --select <choice>   Skip the prompt and select one of: website | linkedin | exit

Examples:
  npx otekin
  npx otekin --non-interactive
  npx otekin --select website --no-open
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
    select: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--non-interactive' || a === '--no-interactive') opts.nonInteractive = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '-s' || a === '--select') {
      opts.select = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith('--select=')) {
      opts.select = a.slice('--select='.length) || null;
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
  if (s === '3' || s === 'exit' || s === 'quit' || s === 'q') return 'exit';
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

function promptMenu() {
  const choices = [
    { label: 'Personal website', value: 'website' },
    { label: 'LinkedIn', value: 'linkedin' },
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
      lines.push('Choose an option (↑/↓ + Enter, or 1-3):');
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

      if (str === '1' || str === '2' || str === '3') {
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

  if (opts.json) {
    process.stdout.write(JSON.stringify({ message: MESSAGE, links: LINKS }, null, 2) + '\n');
    return;
  }

  process.stdout.write(MESSAGE + '\n\n');

  const selectedFromFlag = normalizeSelect(opts.select);
  if (opts.select && !selectedFromFlag) {
    process.stderr.write(`Unknown --select value: ${opts.select}\n`);
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
  showCursor();
  process.stderr.write((err && err.stack) ? String(err.stack) + '\n' : String(err) + '\n');
  process.exitCode = 1;
});


