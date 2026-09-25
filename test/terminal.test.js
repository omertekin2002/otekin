'use strict';

const assert = require('assert');
const { cleanText, createTheme, clipLine, createActivityDisplay, startProgress } = require('../lib/terminal');

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

test('display text strips remote terminal control sequences but keeps readable content', () => {
  assert.strictEqual(cleanText('Hello\u001b[2J\nWorld\u001b]0;bad title\u0007'), 'Hello\nWorld');
});
