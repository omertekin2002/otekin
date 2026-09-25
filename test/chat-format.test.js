'use strict';

const assert = require('assert');
const {
  formatChatResponse,
  splitSourceBlock,
  parseSourceBlock
} = require('../lib/chat-format');

const REDIRECT_ONE = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/very-long-first-token';
const REDIRECT_TWO = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/very-long-second-token';

test('formatChatResponse replaces raw grounding links with one compact source row', () => {
  const response = {
    message: [
      'A researched answer with citations [1][2].',
      '',
      'Sources:',
      `1. [wiktionary.org](<${REDIRECT_ONE}>)`,
      `2. [merriam-webster.com](<${REDIRECT_TWO}>)`
    ].join('\n'),
    webSources: [
      { title: 'wiktionary.org', url: REDIRECT_ONE, snippet: 'A long result snippet.' },
      { title: 'merriam-webster.com', url: REDIRECT_TWO, snippet: 'Another long result snippet.' }
    ]
  };

  assert.strictEqual(
    formatChatResponse(response),
    'A researched answer with citations [1][2].\n\nSources: [1] wiktionary.org · [2] merriam-webster.com'
  );
  assert.doesNotMatch(formatChatResponse(response), /vertexaisearch/);
});

test('formatChatResponse makes compact labels clickable only when requested', () => {
  const response = {
    message: `Answer.\n\nSources:\n1. [example.com](<${REDIRECT_ONE}>)`,
    webSources: [{ title: 'example.com', url: REDIRECT_ONE }]
  };
  const formatted = formatChatResponse(response, { hyperlinks: true });

  assert.match(formatted, /Sources: /);
  assert.match(formatted, /\u001B\]8;;https:\/\/vertexaisearch/);
  assert.match(formatted, /\[1\] example\.com/);
  assert.doesNotMatch(formatChatResponse(response), /\u001B/);
});

test('formatChatResponse falls back to source links parsed from the message', () => {
  const response = {
    message: `Answer.\n\nSources:\n1. [example.com](<${REDIRECT_ONE}>)`
  };

  assert.strictEqual(
    formatChatResponse(response),
    'Answer.\n\nSources: [1] example.com'
  );
});

test('formatChatResponse keeps ordinary source prose and source-free answers intact', () => {
  const prose = 'Sources: can be primary or secondary depending on context.';
  assert.strictEqual(formatChatResponse({ message: prose }), prose);
  assert.strictEqual(formatChatResponse({ message: 'Plain answer.\n\n' }), 'Plain answer.');
});

test('source parsing accepts numbered Markdown links and rejects unrelated text', () => {
  const split = splitSourceBlock(`Answer.\n\nSources:\n1. [example.com](<${REDIRECT_ONE}>)`);
  assert.strictEqual(split.answer, 'Answer.');
  assert.deepStrictEqual(parseSourceBlock(split.sourceBlock), [
    { title: 'example.com', url: REDIRECT_ONE }
  ]);
  assert.deepStrictEqual(parseSourceBlock('not a source line'), []);
});

test('formats only the cited subset of a retained catalog with stable source numbers', () => {
  const response = {
    message: 'Answer [2]\n\nSources:\n- [2] [Current source](<https://source.test/new>)',
    webSources: [{ title: 'Old unused', url: 'https://source.test/old' }, { title: 'Current source', url: 'https://source.test/new' }],
    readSources: [2]
  };
  assert.strictEqual(formatChatResponse(response), 'Answer [2]\n\nSources: [2] Current source');
  assert.strictEqual(formatChatResponse({ message: 'Thanks!', webSources: response.webSources, readSources: [] }), 'Thanks!');
  assert.strictEqual(formatChatResponse({ message: response.message }), 'Answer [2]\n\nSources: [2] Current source');
});

test('saves optional generated PNGs without printing or mutating base64 payloads', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { saveGeneratedImages } = require('../lib/chat-images');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-image-test-'));
  try {
    const base64 = Buffer.from('test image bytes').toString('base64');
    const original = { message: `Picture\n![Generated image](data:image/png;base64,${base64})` };
    const rendered = saveGeneratedImages(original, { directory });
    assert.doesNotMatch(rendered.message, /base64/);
    assert.match(original.message, /base64/);
    const filename = path.join(directory, fs.readdirSync(directory)[0], 'image-1.png');
    assert.strictEqual(fs.readFileSync(filename).toString(), 'test image bytes');
    assert.ok(rendered.message.includes(filename));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('terminal answers style Markdown without altering code blocks or plain output', () => {
  const message = '# Heading\n**Important** and `code`\n```js\nconst x = "**literal**";\n```';
  const styled = formatChatResponse({ message }, { color: true });
  assert.match(styled, /\u001b\[1mHeading/);
  assert.match(styled, /\u001b\[1mImportant/);
  assert.match(styled, /const x = "\*\*literal\*\*";/);
  assert.strictEqual(formatChatResponse({ message }), message);
});
