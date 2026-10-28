'use strict';

const assert = require('assert');
const { Writable } = require('stream');
const { Terminal } = require('@xterm/headless');
const { createTheme, createActivityDisplay } = require('../lib/terminal');
const { createStreamPreview, provisionalText, REDRAW_INTERVAL_MS } = require('../lib/stream-preview');

const SGR = /\u001b\[[0-9;]*m/;
const PROMPT = '$ otekin chat "hi"';

const tick = (ms = REDRAW_INTERVAL_MS * 2) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake terminal stdout that feeds a headless xterm, like a PTY with LF -> CRLF.
function fakeTerminal(options = {}) {
  const columns = options.columns || 40;
  const rows = options.rows || 12;
  const emulator = new Terminal({ cols: columns, rows, convertEol: true, allowProposedApi: true, scrollback: 0 });
  let raw = '';
  let pending = Promise.resolve();
  const stream = new Writable({
    write(chunk, _encoding, done) {
      raw += chunk.toString();
      pending = new Promise((resolve) => emulator.write(chunk.toString(), resolve));
      done();
    }
  });
  Object.assign(stream, { isTTY: true, columns, rows });
  // Start like a shell would: the command line, then the cursor on a fresh line.
  stream.write(PROMPT + '\n');
  const lines = async () => {
    await pending;
    const buffer = emulator.buffer.active;
    return Array.from({ length: emulator.rows }, (_, index) =>
      buffer.getLine(buffer.viewportY + index).translateToString(true));
  };
  return {
    stream,
    emulator,
    raw: () => raw,
    lines,
    screen: async () => (await lines()).join('\n').replace(/\s+$/, ''),
    wrapped: () => Array.from({ length: emulator.rows }, (_, index) =>
      emulator.buffer.active.getLine(index).isWrapped).some(Boolean),
    resize(width, height) {
      emulator.resize(width, height);
      stream.columns = width;
      stream.rows = height;
    },
    dispose: () => emulator.dispose()
  };
}

// What runOneShotChat prints once the canonical answer arrives.
function printAnswer(stream, theme, answer) {
  stream.write('\n' + theme.strong('  AI') + '\n\n' + answer + '\n\n');
}

async function previewRun(deltas, options = {}) {
  const term = fakeTerminal(options);
  const theme = createTheme(term.stream, options.env || {});
  const preview = await createStreamPreview(term.stream, { theme });
  for (const delta of deltas) preview.update(delta);
  await tick();
  return { term, theme, preview };
}

test('provisional text removes terminal escapes and hides inline image data', () => {
  assert.strictEqual(provisionalText('  a\u001b]52;c;ZXZpbA==\u0007b\u001b[2Jc  '), 'abc');
  assert.strictEqual(provisionalText('see ![x](data:image/png;base64,AAAA'), 'see [generating image…]');
  assert.strictEqual(provisionalText('x'.repeat(5000)).length, 4001);
});

test('stream preview draws under the AI header and is fully replaced by the canonical answer', async () => {
  const { term, theme, preview } = await previewRun(['Short ', 'provisional ', 'reply']);
  try {
    const screen = await term.screen();
    assert.match(screen, /^\$ otekin chat "hi"\n\n {2}AI\n\n {2}Short provisional reply\n {2}. Writing · 0s$/);
    assert.match(term.raw(), SGR);
    preview.clear();
    printAnswer(term.stream, theme, 'The canonical answer.');
    assert.strictEqual(await term.screen(), `${PROMPT}\n\n  AI\n\nThe canonical answer.`);
    assert.match(term.raw(), /\u001b\[\?25l[^]*\u001b\[\?25h/);
    // Later deltas are ignored once the answer is printed.
    preview.update('late delta');
    await tick();
    assert.doesNotMatch(await term.screen(), /late delta|provisional/);
  } finally {
    term.dispose();
  }
});

test('stream preview of a long reply shows only the tail and never scrolls the screen', async () => {
  const words = Array.from({ length: 400 }, (_, index) => `word${index}`);
  const { term, theme, preview } = await previewRun(words.map((word) => word + ' '), { columns: 30, rows: 10 });
  try {
    const lines = await term.lines();
    assert.strictEqual(lines[0], PROMPT, 'the command line is still on screen');
    assert.strictEqual(term.emulator.buffer.active.baseY, 0);
    const block = lines.slice(1);
    assert(block.filter((line) => line.trim()).length <= 10 - 2);
    assert.match(lines.slice(1, 9).join('\n'), /word399\n {2}. Writing/);
    assert.doesNotMatch(lines.join('\n'), /word0 /);
    assert.strictEqual(term.wrapped(), false);
    preview.clear();
    assert.strictEqual(await term.screen(), PROMPT);
    printAnswer(term.stream, theme, 'Done.');
    assert.strictEqual(await term.screen(), `${PROMPT}\n\n  AI\n\nDone.`);
  } finally {
    term.dispose();
  }
});

test('stream preview keeps wide characters inside the screen and erases them completely', async () => {
  const text = '界'.repeat(50) + ' 👨‍👩‍👧‍👦 '.repeat(12) + 'é 🇹🇷 '.repeat(10);
  const { term, preview } = await previewRun(Array.from(text), { columns: 21, rows: 12 });
  try {
    const lines = await term.lines();
    assert.strictEqual(lines[0], PROMPT);
    assert.strictEqual(term.emulator.buffer.active.baseY, 0);
    assert.strictEqual(term.wrapped(), false);
    assert.match(lines.join('\n'), /🇹🇷/);
    preview.clear();
    assert.strictEqual(await term.screen(), PROMPT);
  } finally {
    term.dispose();
  }
});

test('stream preview never writes escape sequences or image data from deltas', async () => {
  const deltas = [
    'Clipboard \u001b]52;c;ZXZpbA==\u0007 and ', '\u001b[31mred\u001b[0m and \u009b2J ',
    '\u001b]8;;https://evil.example\u001b\\link\u001b]8;;\u001b\\ then ',
    '![chart](data:image/png;base64,', 'A'.repeat(200), ') done'
  ];
  const { term, preview } = await previewRun(deltas, { columns: 60 });
  try {
    const raw = term.raw();
    assert.doesNotMatch(raw, /\u001b\]|\u009b|\u001b\[31m|\u001b\[2J|evil\.example|AAAAAAAA/);
    assert.match(await term.screen(), /Clipboard {2}and red and {2}link then \[generating image…\]\s+done/);
    preview.clear();
    assert.strictEqual(await term.screen(), PROMPT);
  } finally {
    term.dispose();
  }
});

test('stream preview follows NO_COLOR and redraws at a throttled rate', async () => {
  const { term, preview } = await previewRun([], { env: { NO_COLOR: '' } });
  try {
    for (let index = 0; index < 200; index += 1) preview.update(`d${index} `);
    await tick(REDRAW_INTERVAL_MS * 3);
    const redraws = term.raw().split('\u001b[J').length - 1;
    assert(redraws >= 1 && redraws <= 5, `redraws: ${redraws}`);
    assert.match(await term.screen(), /d199/);
    preview.clear();
    assert.doesNotMatch(term.raw(), SGR);
    assert.strictEqual(await term.screen(), PROMPT);
  } finally {
    term.dispose();
  }
});

test('stream preview erases cleanly after the terminal narrows mid-stream', async () => {
  const { term, preview } = await previewRun(['A reply that fills several rows of the preview ', 'before the window is resized.'],
    { columns: 40, rows: 12 });
  try {
    term.resize(24, 12);
    preview.clear();
    assert.strictEqual(await term.screen(), PROMPT);
  } finally {
    term.dispose();
  }
});

test('tool activity and the preview share one terminal without overwriting each other', async () => {
  const term = fakeTerminal({ columns: 50 });
  const theme = createTheme(term.stream, {});
  const activity = createActivityDisplay(term.stream);
  const preview = await createStreamPreview(term.stream, {
    theme,
    startedAt: activity.startedAt,
    statusLabel: () => activity.runningLabel(),
    onShow: () => activity.pause()
  });
  const onActivity = (event) => preview.around(() => activity.onActivity(event));
  try {
    onActivity({ id: 'a', tool: 'search_web', query: 'first', status: 'running' });
    await tick();
    if (process.env.TERM !== 'dumb') assert.match(await term.screen(), /Searching {2}first/);
    onActivity({ id: 'a', tool: 'search_web', query: 'first', status: 'complete' });
    preview.update('Partial answer');
    onActivity({ id: 'b', tool: 'read_url', query: 'example.com', status: 'running' });
    await tick();
    assert.match(await term.screen(), /^\$ otekin chat "hi"\n {2}✓ Search {2}first\n\n {2}AI\n\n {2}Partial answer\n {2}. Reading page {2}example\.com · 0s$/);
    onActivity({ id: 'b', tool: 'read_url', query: 'example.com', status: 'complete' });
    await tick();
    assert.match(await term.screen(), /✓ Search {2}first\n {2}✓ Read page {2}example\.com\n\n {2}AI\n\n {2}Partial answer\n {2}. Writing/);
    preview.clear();
    activity.finish({});
    printAnswer(term.stream, theme, 'Final.');
    assert.strictEqual(await term.screen(),
      `${PROMPT}\n  ✓ Search  first\n  ✓ Read page  example.com\n\n  AI\n\nFinal.`);
  } finally {
    preview.clear();
    activity.stop();
    term.dispose();
  }
});

test('stream preview keeps output above it when the terminal narrows under a long status row', async () => {
  const term = fakeTerminal({ columns: 80, rows: 12 });
  const theme = createTheme(term.stream, {});
  const label = 'Reading page  ' + 'example.com/'.repeat(4) + 'report';
  const preview = await createStreamPreview(term.stream, { theme, statusLabel: () => label });
  try {
    preview.update('Short preview');
    await tick();
    assert.match(await term.screen(), /Reading page {2}example\.com/);
    term.resize(25, 12);
    preview.clear();
    assert.strictEqual(await term.screen(), PROMPT);
  } finally {
    preview.clear();
    term.dispose();
  }
});
