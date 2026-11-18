'use strict';

const assert = require('assert');
const {
  PROGRESS_FRAMES, cleanText, createTheme, clipLine, createActivityDisplay, reducedMotionFor, startProgress
} = require('../lib/terminal');

test('terminal styling respects pipes, NO_COLOR, and dumb terminals', () => {
  assert.strictEqual(createTheme({ isTTY: false }, {}).accent('text'), 'text');
  assert.strictEqual(createTheme({ isTTY: true }, { NO_COLOR: '' }).muted('text'), 'text');
  assert.strictEqual(createTheme({ isTTY: true }, { TERM: 'dumb' }).strong('text'), 'text');
  assert.match(createTheme({ isTTY: true }, {}).muted('text'), /\u001b\[2mtext/);
});

test('activity display reports real tools once, marks failures, and sanitizes queries', () => {
  let output = '';
  const display = createActivityDisplay({ isTTY: false, columns: 60, write: text => { output += text; } });
  const search = { id: 's', tool: 'search_web', query: 'Ömer\u001b[2J\nTekin', status: 'running' };
  display.onActivity(search);
  assert.strictEqual(output, '');
  display.onActivity({ ...search, status: 'complete' });
  display.onActivity({ id: 'r', tool: 'read_url', query: 'example.com', status: 'error' });
  display.finish({ toolActivity: [{ ...search, status: 'complete' }] });
  display.onActivity({ id: 'late', query: 'late', status: 'complete' });
  assert.strictEqual(output, '  ✓ Search  Ömer Tekin\n  ! Read page  example.com (failed)\n');
  assert.doesNotMatch(output, /\u001b/);
});

test('progress stays within narrow terminal widths and cleans up its timer', async () => {
  assert.strictEqual(clipLine('界界界界界', 5), '界界…');
  assert.strictEqual(clipLine('a'.repeat(80), 20).length, 20);
  assert.strictEqual(clipLine('Ömer', 8), 'Ömer');
  let output = '';
  const stream = { isTTY: true, columns: 30, write: text => { output += text; } };
  const stop = startProgress(stream, 'Searching ' + '界'.repeat(80));
  await new Promise(resolve => setTimeout(resolve, 120));
  stop();
  const snapshot = output;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.strictEqual(output, snapshot);
  if (process.env.TERM !== 'dumb') {
    assert.match(cleanText(output), /Searching/);
    assert.doesNotMatch(output, /\n/);
  }
});

test('reduced motion is on for --reduced-motion or a set OTEKIN_REDUCED_MOTION, and off otherwise', () => {
  assert.strictEqual(reducedMotionFor({ reducedMotion: true }, {}), true);
  for (const value of ['1', 'yes', 'true', 'on']) {
    assert.strictEqual(reducedMotionFor({}, { OTEKIN_REDUCED_MOTION: value }), true, value);
  }
  for (const value of [undefined, '', ' ', '0', 'false', 'no', 'off']) {
    assert.strictEqual(reducedMotionFor({}, { OTEKIN_REDUCED_MOTION: value }), false, String(value));
  }
  assert.strictEqual(reducedMotionFor(null, {}), false);
});

// A fake terminal stderr that records each write.
function recordingStream(columns = 60) {
  const writes = [];
  return { writes, stream: { isTTY: true, columns, write: text => { writes.push(text); } } };
}

test('reduced-motion progress draws a static line once and redraws only when its label changes', async () => {
  if (process.env.TERM === 'dumb') return;
  const { writes, stream } = recordingStream();
  let label = 'Thinking';
  const stop = startProgress(stream, () => label, { reducedMotion: true });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    const first = writes.join('');
    assert.match(first, /… Thinking/);
    // Several 100 ms ticks pass with nothing new: nothing is written.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.strictEqual(writes.join(''), first);
    label = 'Searching  laws';
    await new Promise(resolve => setTimeout(resolve, 150));
    const second = writes.join('').slice(first.length);
    assert.match(second, /… Searching {2}laws/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.strictEqual(writes.join(''), first + second);
    const all = cleanText(writes.join(''));
    assert.doesNotMatch(all, new RegExp(`[${PROGRESS_FRAMES.join('')}]|\\d+s`));
  } finally {
    stop();
  }
});

test('progress keeps its spinner and seconds counter without reduced motion', async () => {
  if (process.env.TERM === 'dumb') return;
  const { writes, stream } = recordingStream();
  const stop = startProgress(stream, 'Thinking');
  await new Promise(resolve => setTimeout(resolve, 350));
  stop();
  const lines = writes.filter(text => /Thinking/.test(text)).map(cleanText);
  assert(lines.length >= 3, `draws: ${lines.length}`);
  assert.match(lines[0], new RegExp(`^ {2}${PROGRESS_FRAMES[0]} Thinking · 0s$`));
  assert.match(lines[1], new RegExp(`^ {2}${PROGRESS_FRAMES[1]} Thinking · 0s$`));
});

test('reduced-motion activity display shows static tool labels and keeps completed lines', async () => {
  if (process.env.TERM === 'dumb') return;
  const { writes, stream } = recordingStream();
  const display = createActivityDisplay(stream, { reducedMotion: true });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    display.onActivity({ id: 's', tool: 'search_web', query: 'courts', status: 'running' });
    await new Promise(resolve => setTimeout(resolve, 250));
    const count = writes.length;
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.strictEqual(writes.length, count);
    display.onActivity({ id: 's', tool: 'search_web', query: 'courts', status: 'complete' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const output = cleanText(writes.join(''));
    assert.match(output, /… Thinking[^]*… Searching {2}courts[^]*✓ Search {2}courts\n[^]*… Thinking/);
    assert.doesNotMatch(output, new RegExp(`[${PROGRESS_FRAMES.join('')}]|\\d+s`));
  } finally {
    display.stop();
  }
});

test('display text strips remote terminal control sequences but keeps readable content', () => {
  assert.strictEqual(cleanText('Hello\u001b[2J\nWorld\u001b]0;bad title\u0007'), 'Hello\nWorld');
});
