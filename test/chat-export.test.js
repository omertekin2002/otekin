'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatChatResponse } = require('../lib/chat-format');
const { transcriptMarkdown, saveTranscript } = require('../lib/chat-export');

const DATE = new Date(2026, 9, 27, 14, 5, 9);
const CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

test('transcriptMarkdown keeps the conversation in order with speaker headings and source links', () => {
  const reply = formatChatResponse({
    message: '# Heading\n\nA **bold** answer with `code` [1][2].\n\nSources:\n1. [one](https://example.com/one)\n2. [two](https://example.com/two)',
    webSources: [
      { title: 'First [draft] source', url: 'https://example.com/one' },
      { title: 'Second', url: 'https://example.com/a (b)' }
    ]
  }, { hyperlinks: true });
  const markdown = transcriptMarkdown([
    { role: 'user', content: 'First question' },
    { role: 'tools', content: '✓ Search  news' },
    { role: 'assistant', model: 'fixture-model', content: 'styled copy', markdown: reply },
    { role: 'notice', content: 'website: https://example.com' },
    { role: 'error', content: 'Chat request failed.' },
    { role: 'user', content: 'Second\tquestion' },
    { role: 'assistant', model: 'OTEKIN', content: 'Restored answer' }
  ], { date: DATE });

  assert.strictEqual(markdown, [
    '# otekin chat · 2026-10-27 14:05',
    '',
    '## You',
    '',
    'First question',
    '',
    '## fixture-model',
    '',
    '# Heading',
    '',
    'A **bold** answer with `code` [1][2].',
    '',
    'Sources: [\\[1\\] First \\[draft\\] source](https://example.com/one) · [\\[2\\] Second](https://example.com/a%20%28b%29)',
    '',
    '## You',
    '',
    'Second  question',
    '',
    '## OTEKIN',
    '',
    'Restored answer',
    ''
  ].join('\n'));
});

test('transcriptMarkdown strips terminal escapes, OSC 8 links to other schemes and control characters', () => {
  const markdown = transcriptMarkdown([
    { role: 'user', content: 'Title\u001b]0;pwned\u0007 question\r\u0007' },
    {
      role: 'assistant',
      model: '\u001b[31mspoofed',
      content: '\u001b[1mBold\u001b[0m \u001b]8;;javascript:alert(1)\u0007click\u001b]8;;\u0007 ' +
        '\u001b[2m\u001b]8;;https://example.com/ok\u0007[1] Ok\u001b]8;;\u0007\u001b[0m\u009b2J'
    }
  ], { date: DATE });
  assert.doesNotMatch(markdown, CONTROLS);
  assert.doesNotMatch(markdown, /pwned|javascript/);
  assert.match(markdown, /## You\n\nTitle question\n/);
  assert.match(markdown, /## spoofed\n\nBold click \[\\\[1\\\] Ok\]\(https:\/\/example\.com\/ok\)\n$/);
});

test('transcriptMarkdown returns null when nothing was said', () => {
  assert.strictEqual(transcriptMarkdown([]), null);
  assert.strictEqual(transcriptMarkdown(undefined), null);
  assert.strictEqual(transcriptMarkdown([{ role: 'notice', content: 'Conversation cleared' }]), null);
});

test('saveTranscript writes a new file each time and never replaces one', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-export-'));
  const messages = [{ role: 'user', content: 'Hello' }, { role: 'assistant', model: 'm', content: 'Hi' }];
  try {
    const existing = path.join(directory, 'otekin-chat-20261027-140509-2.md');
    fs.writeFileSync(existing, 'keep me');
    const first = saveTranscript(directory, messages, { date: DATE });
    const second = saveTranscript(directory, messages, { date: DATE });
    assert.strictEqual(first, path.join(directory, 'otekin-chat-20261027-140509.md'));
    assert.strictEqual(second, path.join(directory, 'otekin-chat-20261027-140509-3.md'));
    assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'keep me');
    assert.strictEqual(fs.readFileSync(second, 'utf8'), transcriptMarkdown(messages, { date: DATE }));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(first).mode & 0o777, 0o600);
    assert.strictEqual(saveTranscript(directory, [], { date: DATE }), null);
    assert.strictEqual(fs.readdirSync(directory).length, 3);
    assert.throws(() => saveTranscript(path.join(directory, 'missing'), messages), { code: 'ENOENT' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
