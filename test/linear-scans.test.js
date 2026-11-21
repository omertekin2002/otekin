'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { cleanText } = require('../lib/terminal');
const { trimTrailingBlankLines } = require('../lib/chat-format');
const { assistantMessageFromResponse } = require('../lib/chat-client');
const { provisionalText } = require('../lib/stream-preview');
const { replaceGeneratedPngs } = require('../lib/chat-images');
const { hideCompleteImageData, hidePartialImageData } = require('../lib/image-data');

// The regular expressions the linear scans replace. They are only safe on short input.
const oldCleanText = (text) => text
  .replace(/(?:\u001B\]|\u009D)[^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
  .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
const oldCompactImages = (text) => hideCompleteImageData(
  text.replace(/!\[([^\]]*)\]\(\s*data:image\/[a-z0-9.+-]+;base64,[^)]+\)/gi,
    (_match, alt) => `[generated image${alt.trim() ? `: ${alt.trim()}` : ''}]`),
  '[generated image data]');
const oldProvisionalText = (text) => hidePartialImageData(
  cleanText(text).replace(/!\[[^\]\n]*\]\(\s*data:image\/[^)]*\)?/gi, '[generating image…]'),
  '[generating image…]').trim();
const oldGeneratedPngs = (text) =>
  text.replace(/!\[[^\]]*\]\(data:image\/png;base64,([A-Za-z0-9+/]+={0,2})\)/g, (_match, base64) => `<${base64}>`);
const oldTrailingBlankLines = (text) => text.replace(/(?:\r?\n[ \t]*)+$/, '');

function seededRandom() {
  let seed = 1;
  return (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
}

function randomTexts(pieces, runs, maxPieces) {
  const random = seededRandom();
  const texts = [];
  for (let run = 0; run < runs; run += 1) {
    let text = '';
    for (let count = 1 + random(maxPieces); count > 0; count -= 1) text += pieces[random(pieces.length)];
    texts.push(text);
  }
  return texts;
}

test('cleanText removes OSC and other escapes exactly as its regular expressions did', () => {
  const pieces = [
    '\u001B', '\u001B]', '\u001B\\', '\u001B[', '\u009D', '\u009B', '\u0007', '\\', ']', '[', 'a', ' ', '\n', '\r',
    '0;', '8;;https://x.test', 'm', '1', '\u0085', '\u009C', 'é'
  ];
  for (const text of randomTexts(pieces, 20000, 20)) {
    assert.strictEqual(cleanText(text), oldCleanText(text), JSON.stringify(text));
  }
});

test('Markdown image scans match the regular expressions they replace', () => {
  const pieces = [
    '![', '!', '[', ']', '(', ')', '](', ' ', '\n', '\r', '\t', ' ', 'alt', 'data:image/', 'DATA:IMAGE/', 'data:image/png;base64,',
    'png', 'PNG', 'svg+xml', ';base64,', ';BASE64,', 'AAAA', 'Ab9+/', '=', '==', 'A'.repeat(200), 'ſ', 'K', '\u001B]0;t\u0007'
  ];
  for (const text of randomTexts(pieces, 30000, 16)) {
    const label = JSON.stringify(text);
    assert.strictEqual(assistantMessageFromResponse({ message: text }).content, oldCompactImages(text), label);
    assert.strictEqual(provisionalText(text), oldProvisionalText(text), label);
    assert.strictEqual(replaceGeneratedPngs(text, (base64) => `<${base64}>`), oldGeneratedPngs(text), label);
  }
});

test('trailing blank lines and whitespace are trimmed exactly as their regular expressions did', () => {
  const pieces = ['\n', '\r', '\r\n', ' ', '\t', 'x', ' ', '\u000B', '\f'];
  for (const text of randomTexts(pieces, 20000, 12)) {
    assert.strictEqual(trimTrailingBlankLines(text), oldTrailingBlankLines(text), JSON.stringify(text));
  }
  // /save uses trimEnd, which trims exactly the characters of \s.
  for (let code = 0; code <= 0xffff; code += 1) {
    const text = 'x' + String.fromCharCode(code).repeat(2);
    assert.strictEqual(text.trimEnd(), text.replace(/\s+$/, ''), `U+${code.toString(16)}`);
  }
});

test('worst-case 24 MiB replies are cleaned, compacted, previewed and saved in seconds', () => {
  const started = Date.now();
  // A separate process, so a regression times out instead of hanging the test run.
  const result = spawnSync(process.execPath, [path.join(__dirname, 'worst-case-replies.js')], {
    encoding: 'utf8',
    timeout: 120000
  });
  assert.strictEqual(result.signal, null, `timed out after ${Date.now() - started} ms`);
  assert.strictEqual(result.status, 0, result.stderr);
  const timings = JSON.parse(result.stdout);
  assert.ok(timings.length >= 10, result.stdout);
});
