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
