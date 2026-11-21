'use strict';

const assert = require('assert');
const {
  PROGRESS_FRAMES, cleanText, createTheme, clipLine, createActivityDisplay, reducedMotionFor, startProgress,
  stringifyJsonForOutput
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

// Bidi embeddings, overrides and isolates, the zero-width space, word joiner and invisible
// operators, and the BOM.
const REMOVED_FORMAT_CODES = [0x200b, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
  0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
// ZWNJ, ZWJ, LRM, RLM and ALM.
const KEPT_FORMAT_CODES = [0x200c, 0x200d, 0x200e, 0x200f, 0x61c];

test('display text drops bidi embeddings, overrides, isolates and stray zero-width characters', () => {
  for (const code of REMOVED_FORMAT_CODES) {
    const char = String.fromCharCode(code);
    assert.strictEqual(cleanText(`a${char}b${char}`), 'ab', `U+${code.toString(16)}`);
  }
  // The characters just outside each removed range stay.
  for (const code of [...KEPT_FORMAT_CODES, 0x200a, 0x2029, 0x202f, 0x205f, 0x2065, 0x206a, 0xfefe, 0xff00]) {
    const text = `a${String.fromCharCode(code)}b`;
    assert.strictEqual(cleanText(text), text, `U+${code.toString(16)}`);
  }
  assert.strictEqual(cleanText('a \u202eexe.gnp\u202c \u2067x\u2069 \u200bz\u2060w\ufeff'), 'a exe.gnp x zw');
  // An emoji ZWJ sequence, a Persian word with ZWNJ and RTL text with its marks come out unchanged.
  for (const text of ['👩\u200d💻', 'می\u200cخواهم', 'שלום\u200f (123)\u200e', 'مرحبا\u061c 1']) {
    assert.strictEqual(cleanText(text), text);
  }
  assert.strictEqual(cleanText('a \u202eb\u202c \u2067c\u2069 \u200bd\u2060e\ufeff 👩\u200d💻 می\u200cخواهم \u200ff'),
    'a b c de 👩\u200d💻 می\u200cخواهم \u200ff');
  // Removing them never joins the pieces of an escape sequence.
  assert.strictEqual(cleanText('\u001b\u202e[31mred'), '[31mred');
});

// DEL, C1 controls and the bidi marks, embeddings, overrides and isolates.
const JSON_UNSAFE_CODES = [0x7f, ...Array.from({ length: 0x20 }, (_, index) => 0x80 + index),
  0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const RAW_JSON_UNSAFE = /[\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

test('JSON output escapes DEL, C1 and bidi controls and parses to the same value', () => {
  for (const code of JSON_UNSAFE_CODES) {
    const char = String.fromCharCode(code);
    const value = { [`key${char}`]: [`a${char}b`, { nested: char }], n: 1 };
    const output = stringifyJsonForOutput(value);
    assert.doesNotMatch(output, RAW_JSON_UNSAFE, `U+${code.toString(16)}`);
    const escape = '\\u' + code.toString(16).padStart(4, '0');
    assert.strictEqual(output.split(escape).length - 1, 3, `U+${code.toString(16)}`);
    assert.deepStrictEqual(JSON.parse(output), value);
    assert.strictEqual(output, JSON.stringify(value, null, 2).split(char).join(escape));
  }
  const reply = { message: 'x\u009B31m\u009D0;t\u0007\u202E\u0085\u007F', sources: [{ title: '\u2066a\u2069', url: 'https://e.test/\u009b' }] };
  assert.deepStrictEqual(JSON.parse(stringifyJsonForOutput(reply)), reply);
  // Escapes already in a string stay literal text, not a second level of escaping.
  assert.deepStrictEqual(JSON.parse(stringifyJsonForOutput({ text: '\\u009b' })), { text: '\\u009b' });
});

test('JSON output is unchanged without unsafe characters, including emoji ZWJ, ZWNJ and BOM', () => {
  const values = [
    { message: 'Ömer · Koç 界 \u{1F469}\u200D\u{1F4BB} می\u200Cخواهم \u200B\uFEFF', list: [1, true, null] },
    'plain', 42, null, [], {}, { control: '\u0000\u001b[2J\n\t' }
  ];
  for (const value of values) {
    assert.strictEqual(stringifyJsonForOutput(value), JSON.stringify(value, null, 2));
  }
});

test('chatErrorMessage shows a cleaned category, a well-formed request ID and what the failure stage means', () => {
  const { chatErrorMessage } = require('../lib/terminal');
  const busy = Object.assign(new Error('Chat service is busy.\u001b]52;c;ZXZpbA==\u0007‮'), { requestId: ' req-42 ' });
  // Without a stage, as for a prompt rejected before anything is sent, only the category and ID.
  assert.strictEqual(chatErrorMessage(busy), 'Chat service is busy. (Request ID: req-42)');
  assert.strictEqual(chatErrorMessage(null), 'Chat request failed.');
  assert.strictEqual(chatErrorMessage({ message: 'Bad id', requestId: 'bad id\u001b[2J' }), 'Bad id');
  for (const requestId of ['-starts-with-dash', 'a'.repeat(129), 'has space', 42]) {
    assert.strictEqual(chatErrorMessage({ message: 'Failed.', requestId }), 'Failed.');
  }
  assert.strictEqual(chatErrorMessage({ message: 'Failed.', requestId: 'A1._:-z' }), 'Failed. (Request ID: A1._:-z)');
  assert.strictEqual(chatErrorMessage(busy, null, { retryHint: true }), 'Chat service is busy. (Request ID: req-42)');

  assert.strictEqual(chatErrorMessage(new Error('Chat service did not wake up in time.'), 'readiness'),
    'Chat service did not wake up in time. Your question was not sent.');
  assert.strictEqual(chatErrorMessage(new Error('Unable to wake chat service.'), 'readiness', { retryHint: true }),
    'Unable to wake chat service. Your question was not sent. Type /retry to send it again.');
  assert.strictEqual(chatErrorMessage(busy, 'request'),
    'Chat service is busy. (Request ID: req-42) The chat service may have received your question.');
  assert.strictEqual(chatErrorMessage({ message: 'Bad id' }, 'request', { retryHint: true }),
    'Bad id. The chat service may have received your question. Type /retry to send it again.');
  assert.doesNotMatch(chatErrorMessage(busy, 'request', { retryHint: true }), /not sent/);
});
