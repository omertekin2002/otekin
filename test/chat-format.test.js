'use strict';

const assert = require('assert');
const {
  formatChatResponse,
  resolveChatResponse,
  formatResolvedResponse,
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

test('formats gapped stable source IDs without pairing citation 2 with source 65', () => {
  const response = {
    message: 'Kept [2], new [65]\n\nSources:\n- [2] [Old 2](<https://old.test/2>)\n- [65] [New source](<https://new.test/>)',
    webSources: [
      { number: 2, title: 'Old 2', url: 'https://old.test/2' },
      { number: 65, title: 'New source', url: 'https://new.test/' }
    ],
    readSources: [65]
  };

  assert.strictEqual(formatChatResponse(response), 'Kept [2], new [65]\n\nSources: [2] Old 2 · [65] New source');
  const linked = formatChatResponse(response, { hyperlinks: true });
  assert.ok(linked.includes('\u001B]8;;https://old.test/2\u0007[2] Old 2\u001B]8;;\u0007'));
  assert.ok(linked.includes('\u001B]8;;https://new.test/\u0007[65] New source\u001B]8;;\u0007'));
});

test('keeps footer subset and order for high and reordered catalog IDs', () => {
  const response = {
    message: 'Answer [9007199254740991][2]\n\nSources:\n- [9007199254740991] [Footer high](<https://footer.test/high>)\n- [2] [Footer old](<https://footer.test/old>)',
    webSources: [
      { number: 65, title: 'Unused', url: 'https://source.test/unused' },
      { number: 2, title: 'Old', url: 'https://source.test/old' },
      { number: Number.MAX_SAFE_INTEGER, title: 'High', url: 'https://source.test/high' }
    ],
    readSources: [65]
  };

  assert.strictEqual(formatChatResponse(response), 'Answer [9007199254740991][2]\n\nSources: [9007199254740991] High · [2] Old');
  const linked = formatChatResponse(response, { hyperlinks: true });
  assert.ok(linked.includes('\u001B]8;;https://source.test/high\u0007[9007199254740991] High'));
  assert.ok(linked.includes('\u001B]8;;https://source.test/old\u0007[2] Old'));
  assert.doesNotMatch(linked, /footer\.test|Unused/);
});

test('uses footer details when an ID is absent instead of unrelated positional metadata', () => {
  const response = {
    message: 'Answer [1][66]\n\nSources:\n- [1] [Footer one](<https://footer.test/one>)\n- [66] [Footer new](<https://footer.test/new>)',
    webSources: [{ number: 65, title: 'Unrelated', url: 'https://wrong.test/' }]
  };

  assert.strictEqual(formatChatResponse(response), 'Answer [1][66]\n\nSources: [1] Footer one · [66] Footer new');
  const linked = formatChatResponse(response, { hyperlinks: true });
  assert.ok(linked.includes('\u001B]8;;https://footer.test/one\u0007[1] Footer one'));
  assert.ok(linked.includes('\u001B]8;;https://footer.test/new\u0007[66] Footer new'));
  assert.doesNotMatch(linked, /wrong\.test|Unrelated/);
});

test('uses positions only for numberless entries in mixed catalogs and gives explicit IDs priority', () => {
  const response = {
    message: 'Answer [3][2][1][4]\n\nSources:\n- [3] [Footer three](<https://footer.test/three>)\n- [2] [Footer two](<https://footer.test/two>)\n- [1] [Footer one](<https://footer.test/one>)\n- [4] [Footer four](<https://footer.test/four>)',
    webSources: [
      { number: 2, title: 'Explicit two', url: 'https://source.test/two' },
      { title: 'Colliding legacy two', url: 'https://wrong.test/two' },
      { title: 'Legacy three', url: 'https://source.test/three' },
      { number: 65, title: 'Unrelated', url: 'https://wrong.test/sixty-five' }
    ]
  };

  assert.strictEqual(formatChatResponse(response), 'Answer [3][2][1][4]\n\nSources: [3] Legacy three · [2] Explicit two · [1] Footer one · [4] Footer four');
  // Explicit IDs also win when their entries follow a colliding legacy position.
  assert.strictEqual(formatChatResponse({
    message: 'Answer [1]\n\nSources:\n- [1] [Footer](<https://footer.test/>)',
    webSources: [
      { title: 'Colliding legacy one', url: 'https://wrong.test/' },
      { number: 1, title: 'Explicit one', url: 'https://source.test/one' }
    ]
  }), 'Answer [1]\n\nSources: [1] Explicit one');
});

test('metadata-only fallback retains explicit IDs and suppresses unused retained sources', () => {
  const response = {
    message: 'Answer.',
    webSources: [
      { number: 65, title: 'New', url: 'https://source.test/new' },
      { number: 2, title: 'Old', url: 'https://source.test/old' },
      { title: 'Legacy third', url: 'https://source.test/third' },
      { number: Number.MAX_SAFE_INTEGER, url: 'https://high.test/' },
      { number: 66 }
    ]
  };

  assert.strictEqual(formatChatResponse(response), 'Answer.\n\nSources: [65] New · [2] Old · [3] Legacy third · [9007199254740991] high.test · [66] Source 66');
  assert.strictEqual(formatChatResponse({ ...response, readSources: [] }), 'Answer.');
  assert.strictEqual(formatChatResponse({ ...response, readSources: [65] }), 'Answer.');
  assert.strictEqual(formatChatResponse({
    message: 'Answer.',
    webSources: [{ title: 'Colliding legacy' }, { number: 1, title: 'Explicit' }]
  }), 'Answer.\n\nSources: [1] Explicit');
});

test('legacy footer fallback preserves explicit IDs and matches missing titles by URL', () => {
  const response = {
    message: 'Answer.\n\nSources:\n1. [Footer old](<https://source.test/old>)\n2. [Footer new](<https://source.test/new>)',
    webSources: [
      { number: 65, url: 'https://source.test/new' },
      { number: 2, title: 'Old metadata', url: 'https://source.test/old' }
    ]
  };

  assert.strictEqual(formatChatResponse(response), 'Answer.\n\nSources: [65] Footer new · [2] Old metadata');
  const linked = formatChatResponse(response, { hyperlinks: true });
  assert.ok(linked.includes('\u001B]8;;https://source.test/new\u0007[65] Footer new'));
  assert.ok(linked.includes('\u001B]8;;https://source.test/old\u0007[2] Old metadata'));
  assert.strictEqual(formatChatResponse({
    ...response,
    message: 'Answer [65][2]\n\nSources:\n- [65] [Footer new](<https://source.test/new>)\n- [Footer old](<https://source.test/old>)'
  }), 'Answer [65][2]\n\nSources: [65] Footer new · [2] Old metadata');
  assert.strictEqual(formatChatResponse({
    message: 'Answer.\n\nSources:\n- https://legacy.test/',
    webSources: [{ title: 'Legacy metadata', url: 'https://legacy.test/' }]
  }), 'Answer.\n\nSources: [1] Legacy metadata');
});

test('mixed footers keep the canonical block when citation numbers would collide', () => {
  const mixed = 'Answer [2]\n\nSources:\n- [2] [A](https://a.test/)\n- [B](https://b.test/)';
  assert.strictEqual(formatChatResponse({ message: mixed }), mixed);
  // A numberless position cannot borrow another catalog source's stable ID.
  const positional = 'Answer [1]\n\nSources:\n- [1] [A](https://a.test/)\n- [B](https://b.test/)';
  assert.strictEqual(formatChatResponse({
    message: positional,
    webSources: [{ number: 2, title: 'Two', url: 'https://two.test/' }]
  }), positional);
  const duplicate = 'Answer [2]\n\nSources:\n- [2] [A](https://a.test/)\n- [2] [B](https://b.test/)';
  assert.strictEqual(formatChatResponse({ message: duplicate }), duplicate);
  const sameId = 'Answer [2]\n\nSources:\n- [2] [A](https://a.test/)\n- [Again](https://two.test/)';
  assert.strictEqual(formatChatResponse({
    message: sameId,
    webSources: [{ number: 2, title: 'Two', url: 'https://two.test/' }]
  }), sameId);

  // Distinct positions and URL matches to distinct stable IDs still format.
  assert.strictEqual(
    formatChatResponse({ message: 'Answer [1][2]\n\nSources:\n- [1] [A](https://a.test/)\n- [B](https://b.test/)' }),
    'Answer [1][2]\n\nSources: [1] A · [2] B'
  );
  const resolved = {
    message: 'Answer [65][2]\n\nSources:\n- [Footer two](https://two.test/)\n- [65] [Footer new](https://new.test/)',
    webSources: [
      { number: 65, title: 'New', url: 'https://new.test/' },
      { number: 1, title: 'Unrelated', url: 'https://wrong.test/' },
      { number: 2, title: 'Two', url: 'https://two.test/' }
    ]
  };
  assert.strictEqual(formatChatResponse(resolved), 'Answer [65][2]\n\nSources: [2] Two · [65] New');
  const linked = formatChatResponse(resolved, { hyperlinks: true });
  assert.ok(linked.includes('\u001B]8;;https://two.test/\u0007[2] Two'));
  assert.ok(linked.includes('\u001B]8;;https://new.test/\u0007[65] New'));
});

test('invalid explicit catalog IDs are never treated as numberless legacy entries', () => {
  const message = 'Answer [1]\n\nSources:\n- [1] [Footer](<https://footer.test/>)';
  for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, true]) {
    const webSources = [{ number, title: 'Invalid metadata', url: 'https://wrong.test/' }];
    assert.strictEqual(formatChatResponse({ message, webSources }), 'Answer [1]\n\nSources: [1] Footer');
    assert.strictEqual(formatChatResponse({ message: 'Answer.', webSources }), 'Answer.');
  }
  for (const invalid of [null, false, 'invalid', []]) {
    assert.strictEqual(formatChatResponse({ message, webSources: [invalid] }), 'Answer [1]\n\nSources: [1] Footer');
    assert.strictEqual(formatChatResponse({ message: 'Answer.', webSources: [invalid] }), 'Answer.');
  }
});

test('partial stable metadata matches legacy footer sources once without dropping unmatched links', () => {
  const response = {
    message: 'Answer.\n\nSources:\n1. [First footer](<https://source.test/first>)\n2. [Second footer](<https://source.test/second>)',
    webSources: [{ number: 65, title: 'Second metadata', url: 'https://source.test/second' }]
  };
  assert.strictEqual(formatChatResponse(response), 'Answer.\n\nSources: [65] Second metadata · [1] First footer');
  const linked = formatChatResponse(response, { hyperlinks: true });
  assert.ok(linked.includes('\u001B]8;;https://source.test/first\u0007[1] First footer'));
  assert.ok(linked.includes('\u001B]8;;https://source.test/second\u0007[65] Second metadata'));
  assert.strictEqual((linked.match(/https:\/\/source\.test\/second/g) || []).length, 1);

  // A numberless footer cannot assign a conflicting ID: preserve its canonical source block.
  assert.strictEqual(formatChatResponse({
    ...response,
    webSources: [{ number: 1, title: 'Second metadata', url: 'https://source.test/second' }]
  }), response.message);
});

test('invalid footer IDs are omitted without rounding or renumbering valid citations', () => {
  const message = 'Answer [2]\n\nSources:\n- [0] [Zero](<https://wrong.test/zero>)\n- [9007199254740993] [Unsafe](<https://wrong.test/unsafe>)\n- [2] [Valid](<https://source.test/>)';
  assert.strictEqual(formatChatResponse({ message }), 'Answer [2]\n\nSources: [2] Valid');
});

test('stable source resolution preserves safe links, title cleanup and color output', () => {
  const response = {
    message: 'Answer [65]\n\nSources:\n- [65] [Footer](<https://source.test/safe>)',
    webSources: [{ number: 65, title: '**Safe**\n\t title\u0007', url: 'javascript:alert(1)' }]
  };
  const expected = 'Answer [65]\n\nSources: [65] Safe title';
  assert.strictEqual(formatChatResponse(response), expected);
  assert.strictEqual(formatChatResponse(response, { color: true }), 'Answer [65]\n\n\u001B[2mSources: [65] Safe title\u001B[0m');
  const linked = formatChatResponse(response, { hyperlinks: true });
  assert.ok(linked.includes('\u001B]8;;https://source.test/safe\u0007[65] Safe title'));
  assert.doesNotMatch(linked, /javascript:|\*\*/);
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

test('a resolved answer and its sources render exactly like the response they came from', () => {
  const responses = [
    { message: 'Plain answer.\n\n' },
    { message: '# Cited **answer** [1][2]\n\nSources:\n- [1] [Footer one](<https://footer.test/one>)\n- [2] [Footer two](<https://footer.test/two>)' },
    { message: 'Answer [1].', webSources: [{ title: 'Source\u001b]0;x\u0007', url: 'https://example.com/source' }, { title: 'Bad', url: 'javascript:alert(1)' }] }
  ];
  for (const response of responses) {
    const resolved = resolveChatResponse(response);
    for (const options of [{}, { hyperlinks: true }, { hyperlinks: true, color: true }]) {
      assert.strictEqual(formatResolvedResponse(resolved, options), formatChatResponse(response, options));
    }
  }
  assert.deepStrictEqual(resolveChatResponse(responses[0]), { answer: 'Plain answer.', sources: [] });
  assert.deepStrictEqual(resolveChatResponse(responses[1]), {
    answer: '# Cited **answer** [1][2]',
    sources: [
      { number: 1, title: 'Footer one', url: 'https://footer.test/one' },
      { number: 2, title: 'Footer two', url: 'https://footer.test/two' }
    ]
  });
  assert.deepStrictEqual(resolveChatResponse(responses[2]).sources, [
    // Titles lose their control characters, so no escape sequence survives.
    { number: 1, title: 'Source]0;x', url: 'https://example.com/source' },
    { number: 2, title: 'Bad', url: null }
  ]);
});

test('source titles lose C1 control characters, so saved history keeps them', () => {
  const store = require('../lib/chat-history');
  const resolved = resolveChatResponse({
    message: 'Answer [1].\n\nSources:\n- [1] [Footer](https://example.com/news)',
    webSources: [{ number: 1, title: 'News\u0085Title\u009b31m', url: 'https://example.com/news' }]
  });
  assert.deepStrictEqual(resolved.sources, [{ number: 1, title: 'NewsTitle31m', url: 'https://example.com/news' }]);
  assert.doesNotMatch(formatResolvedResponse(resolved, { hyperlinks: true }), /[\u0080-\u009F]/);
  // The cleaned title is one that saved history accepts, so the reply keeps its link.
  const saved = JSON.parse(store.serializeHistory({
    history: [], messages: [{ role: 'assistant', content: 'x', ...resolved }], prompts: []
  }));
  assert.deepStrictEqual(saved.messages[0].sources, resolved.sources);
});

test('sources keep their whole title, up to what saved history accepts, while the source row shortens it', () => {
  const store = require('../lib/chat-history');
  const long = 'A remarkably long source title that keeps going well past the forty-eight characters';
  const huge = 'word '.repeat(80).trim();
  const resolved = resolveChatResponse({
    message: 'Answer [1][2].',
    webSources: [{ number: 1, title: long, url: 'https://example.com/long' }, { number: 2, title: huge, url: 'https://example.com/huge' }]
  });
  assert.strictEqual(resolved.sources[0].title, long);
  assert(resolved.sources[1].title.length <= store.MAX_SOURCE_TITLE_CHARACTERS);
  assert(resolved.sources[1].title.length > 240);
  assert.match(resolved.sources[1].title, /^word word .*…$/);
  assert.strictEqual(formatResolvedResponse(resolved),
    'Answer [1][2].\n\nSources: [1] A remarkably long source title that keeps going… · [2] word word word word word word word word word wo…');
  const saved = JSON.parse(store.serializeHistory({
    history: [], messages: [{ role: 'assistant', content: 'x', ...resolved }], prompts: []
  }));
  assert.deepStrictEqual(saved.messages[0].sources, resolved.sources);
});
