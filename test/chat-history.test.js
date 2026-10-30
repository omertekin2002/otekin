'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/chat-history');

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-history-'));
  return { directory, file: path.join(directory, 'nested', 'history.json') };
}

function conversation() {
  return {
    history: [
      { role: 'user', content: 'What changed?' },
      {
        role: 'assistant',
        content: 'A lot changed [1].',
        agentMessages: [{ role: 'tool', content: 'search result' }],
        webSources: [{ title: 'Source', url: 'https://example.com/source' }]
      }
    ],
    messages: [
      { role: 'user', content: 'What changed?' },
      { role: 'tools', content: '\u001b[2m✓ Search  news\u001b[0m' },
      { role: 'assistant', model: 'fixture-model', content: 'A lot \u001b[1mchanged\u001b[0m [1].' }
    ],
    prompts: ['What changed?']
  };
}

test('chat history resolves its file per platform and honors the overrides', () => {
  assert.strictEqual(store.resolveHistoryFile({}, 'linux', '/home/ada'), '/home/ada/.local/state/otekin/history.json');
  assert.strictEqual(store.resolveHistoryFile({ XDG_STATE_HOME: '/srv/state' }, 'linux', '/home/ada'),
    '/srv/state/otekin/history.json');
  assert.strictEqual(store.resolveHistoryFile({ XDG_STATE_HOME: 'relative/state' }, 'freebsd', '/home/ada'),
    '/home/ada/.local/state/otekin/history.json');
  assert.strictEqual(store.resolveHistoryFile({ XDG_STATE_HOME: '/srv/state' }, 'darwin', '/Users/ada'),
    '/Users/ada/Library/Application Support/otekin/history.json');
  assert.strictEqual(store.resolveHistoryFile({ LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, 'win32', 'C:\\Users\\ada'),
    'C:\\Users\\ada\\AppData\\Local\\otekin\\history.json');
  assert.strictEqual(store.resolveHistoryFile({}, 'win32', 'C:\\Users\\ada'),
    'C:\\Users\\ada\\AppData\\Local\\otekin\\history.json');
  assert.strictEqual(store.resolveHistoryFile({ OTEKIN_HISTORY_FILE: '/tmp/h.json' }, 'linux', '/home/ada'), '/tmp/h.json');
  assert.strictEqual(store.resolveHistoryFile({}, 'linux', ''), null);

  const env = { OTEKIN_HISTORY_FILE: '/tmp/h.json' };
  assert.strictEqual(store.historyFileFor({}, env, 'linux', '/home/ada'), '/tmp/h.json');
  assert.strictEqual(store.historyFileFor({ noHistory: true }, env, 'linux', '/home/ada'), null);
  for (const value of ['1', 'true', 'yes']) {
    assert.strictEqual(store.historyFileFor({}, { ...env, OTEKIN_NO_HISTORY: value }, 'linux', '/home/ada'), null, value);
  }
  for (const value of ['', '0', 'false']) {
    assert.strictEqual(store.historyFileFor({}, { ...env, OTEKIN_NO_HISTORY: value }, 'linux', '/home/ada'), '/tmp/h.json', value);
  }
});

test('chat history round-trips a conversation as plain text', () => {
  const { directory, file } = tempFile();
  try {
    assert.strictEqual(store.loadHistory(file), null);
    store.saveHistory(file, conversation());
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.version, 1);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\\u001b/);
    const restored = store.loadHistory(file);
    assert.deepStrictEqual(restored.history, conversation().history);
    assert.deepStrictEqual(restored.messages, [
      { role: 'user', content: 'What changed?' },
      { role: 'tools', content: '✓ Search  news' },
      { role: 'assistant', model: 'fixture-model', content: 'A lot changed [1].' }
    ]);
    assert.deepStrictEqual(restored.prompts, ['What changed?']);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['history.json'], 'no temp files are left behind');

    store.saveHistory(file, { history: [], messages: [{ role: 'notice', content: 'Second save' }], prompts: [] });
    assert.deepStrictEqual(store.loadHistory(file).messages, [{ role: 'notice', content: 'Second save' }]);
    store.clearHistory(file);
    assert.strictEqual(fs.existsSync(file), false);
    store.clearHistory(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('chat history keeps the catalog before the newest one, as the live session does', () => {
  const first = [{ title: 'First', url: 'https://example.com/first' }];
  const second = first.concat({ title: 'Second', url: 'https://example.com/second' });
  const history = [
    { role: 'user', content: 'One' },
    { role: 'assistant', content: 'Answer one [1].', webSources: first },
    { role: 'user', content: 'Two' },
    { role: 'assistant', content: 'Answer two [2].', webSources: second }
  ];
  const parse = (items) => store.parseHistory(JSON.stringify({ version: 1, history: items, messages: [], prompts: [] }));
  assert.deepStrictEqual(parse(history).history, history);
  // Older catalogs are still dropped, and a last turn without sources needs nothing restored.
  const older = [{ role: 'user', content: 'Zero' }, { role: 'assistant', content: 'Answer zero.', webSources: first }];
  assert.strictEqual(parse(older.concat(history)).history[1].webSources, undefined);
  const plain = history.slice(0, 2).concat({ role: 'user', content: 'Two' }, { role: 'assistant', content: 'No sources.' });
  assert.deepStrictEqual(parse(plain).history, plain);
});

test('chat history keeps the in-memory bounds', () => {
  const { directory, file } = tempFile();
  try {
    const turns = Array.from({ length: 40 }, (_, index) => [
      { role: 'user', content: `Question ${index}` },
      { role: 'assistant', content: `Answer ${index}` }
    ]).flat();
    store.saveHistory(file, {
      history: turns,
      messages: Array.from({ length: 150 }, (_, index) => ({ role: 'notice', content: `Notice ${index}` })),
      prompts: Array.from({ length: 80 }, (_, index) => `Prompt ${index}`)
    });
    const restored = store.loadHistory(file);
    assert.strictEqual(restored.messages.length, 100);
    assert.strictEqual(restored.messages[0].content, 'Notice 50');
    assert.strictEqual(restored.prompts.length, 50);
    assert.strictEqual(restored.prompts[0], 'Prompt 30');
    // One request slot is left for the next prompt.
    assert(restored.history.length < turns.length);
    assert.strictEqual(restored.history[restored.history.length - 1].content, 'Answer 39');

    const huge = 'x'.repeat(30000);
    const text = store.serializeHistory({
      history: [],
      messages: Array.from({ length: 100 }, (_, index) => ({ role: 'notice', content: `${index} ${huge}` })),
      prompts: []
    });
    assert(Buffer.byteLength(text) <= store.MAX_FILE_BYTES);
    const parsed = JSON.parse(text);
    assert(parsed.messages.length < 100);
    assert.match(parsed.messages[parsed.messages.length - 1].content, /^99 /);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function sourcedReply(extra) {
  return {
    role: 'assistant',
    model: 'fixture-model',
    content: 'Cited answer [1][2].\n\nSources: [1] First · [2] Second',
    answer: 'Cited **answer** [1][2].',
    sources: [
      { number: 1, title: 'First', url: 'https://example.com/first' },
      { number: 2, title: 'Second', url: null }
    ],
    ...extra
  };
}

test('chat history keeps a reply\'s answer and sources so its links can be rebuilt', () => {
  const { directory, file } = tempFile();
  try {
    const state = conversation();
    state.messages.push({ role: 'user', content: 'Cite it' },
      sourcedReply({ markdown: 'never saved \u001b]8;;https://example.com/first\u0007[1] First\u001b]8;;\u0007' }));
    store.saveHistory(file, state);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.version, 1);
    assert.deepStrictEqual(saved.messages[4], {
      role: 'assistant',
      content: 'Cited answer [1][2].\n\nSources: [1] First · [2] Second',
      model: 'fixture-model',
      answer: 'Cited **answer** [1][2].',
      sources: [{ number: 1, title: 'First', url: 'https://example.com/first' }, { number: 2, title: 'Second' }]
    });
    assert.deepStrictEqual(store.loadHistory(file).messages[4], sourcedReply());
    // A reply without sources, as from an older version, stays plain text.
    assert.deepStrictEqual(store.loadHistory(file).messages[2],
      { role: 'assistant', model: 'fixture-model', content: 'A lot changed [1].' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('chat history drops malformed reply sources and keeps the reply as plain text', () => {
  const source = { number: 1, title: 'First', url: 'https://example.com/first' };
  const plain = { role: 'assistant', model: 'fixture-model', content: 'Cited answer [1][2].\n\nSources: [1] First · [2] Second' };
  const cases = [
    { sources: [{ ...source, url: 'javascript:alert(1)' }] },
    { sources: [{ ...source, url: 'ftp://example.com/file' }] },
    { sources: [{ ...source, url: 'file:///etc/passwd' }] },
    { sources: [{ ...source, url: '/relative/path' }] },
    { sources: [{ ...source, url: 'https://example.com/a b' }] },
    { sources: [{ ...source, url: 'https://example.com/\u001b]8;;x' }] },
    { sources: [{ ...source, url: 'https://example.com/\u0085' }] },
    { sources: [{ ...source, url: 'HTTPS://Example.com' }] },
    { sources: [{ ...source, url: `https://example.com/${'a'.repeat(store.MAX_SOURCE_URL_CHARACTERS)}` }] },
    { sources: [{ ...source, url: 7 }] },
    { sources: [{ ...source, number: 1.5 }] },
    { sources: [{ ...source, number: 0 }] },
    { sources: [{ ...source, number: -1 }] },
    { sources: [{ ...source, number: '1' }] },
    { sources: [{ ...source, number: 2 ** 53 }] },
    { sources: [{ ...source, title: 'x'.repeat(store.MAX_SOURCE_TITLE_CHARACTERS + 1) }] },
    { sources: [{ ...source, title: 'Two\nlines' }] },
    { sources: [{ ...source, title: 'Tab\there' }] },
    { sources: [{ ...source, title: '\u001b]0;pwned\u0007Title' }] },
    { sources: [{ ...source, title: '\u001b[31mRed' }] },
    { sources: [{ ...source, title: null }] },
    { sources: [{ ...source, title: 'News\u0085Title' }] },
    { sources: [] },
    { sources: {} },
    { sources: 'https://example.com/first' },
    { sources: [null] },
    { sources: [[1, 'First', 'https://example.com/first']] },
    { answer: 7 },
    { answer: undefined },
    { sources: undefined }
  ];
  for (const extra of cases) {
    const restored = store.parseHistory(JSON.stringify({
      version: 1,
      history: [],
      messages: [{ role: 'user', content: 'Cite it' }, sourcedReply(extra)],
      prompts: []
    }));
    assert(restored, JSON.stringify(extra).slice(0, 80));
    assert.deepStrictEqual(restored.messages, [{ role: 'user', content: 'Cite it' }, plain], JSON.stringify(extra).slice(0, 80));
    // Nothing invalid is written back either.
    const saved = JSON.parse(store.serializeHistory({ history: [], messages: [sourcedReply(extra)], prompts: [] }));
    assert.strictEqual(saved.messages[0].sources, undefined, JSON.stringify(extra).slice(0, 80));
  }
  // Sources on any other role are ignored.
  const restored = store.parseHistory(JSON.stringify({
    version: 1, history: [], messages: [{ ...sourcedReply(), role: 'user' }], prompts: []
  }));
  assert.deepStrictEqual(restored.messages, [{ role: 'user', content: plain.content }]);
  // Terminal escapes in a stored answer are removed.
  const escaped = store.parseHistory(JSON.stringify({
    version: 1, history: [], messages: [sourcedReply({ answer: 'Safe\u001b]0;x\u0007 answer\u001b[2J' })], prompts: []
  }));
  assert.strictEqual(escaped.messages[0].answer, 'Safe answer');
});

test('chat history drops only the unusable sources of a reply and keeps the rest', () => {
  const sources = [1, 2, 3, 4, 5].map((number) => ({ number, title: `Source ${number}`, url: `https://example.com/${number}` }));
  const long = `https://example.com/track?id=${'a'.repeat(2100)}`;
  const reply = (list) => sourcedReply({ answer: 'Cited [1][2][3][4][5].', sources: list });
  const restore = (list) => store.parseHistory(JSON.stringify({
    version: 1, history: [], messages: [reply(list)], prompts: []
  })).messages[0].sources;
  const kept = (...numbers) => sources.filter((source) => numbers.includes(source.number));

  // One long tracking link loses only that source; the others keep their numbers and links.
  const withLong = sources.map((source) => (source.number === 3 ? { ...source, url: long } : source));
  assert.deepStrictEqual(restore(withLong), kept(1, 2, 4, 5));
  const saved = JSON.parse(store.serializeHistory({ history: [], messages: [reply(withLong)], prompts: [] }));
  assert.strictEqual(saved.messages[0].answer, 'Cited [1][2][3][4][5].');
  assert.deepStrictEqual(saved.messages[0].sources, kept(1, 2, 4, 5));

  // Every other kind of bad entry is dropped alone too.
  assert.deepStrictEqual(restore([
    sources[0], null, { ...sources[1], url: 'javascript:alert(1)' }, { ...sources[2], title: 'Bad\u0085title' },
    { ...sources[3], number: 0 }, sources[4], { ...sources[0], title: 'Same number' }
  ]), kept(1, 5));

  // A list longer than the cap keeps its first sources.
  const many = Array.from({ length: store.MAX_SOURCES + 5 }, (_, index) =>
    ({ number: index + 1, title: `Source ${index + 1}`, url: `https://example.com/${index + 1}` }));
  assert.deepStrictEqual(restore(many), many.slice(0, store.MAX_SOURCES));
});

test('chat history stays under its size cap with many large source lists', () => {
  const { directory, file } = tempFile();
  try {
    const sources = Array.from({ length: store.MAX_SOURCES }, (_, index) => ({
      number: index + 1,
      title: 't'.repeat(store.MAX_SOURCE_TITLE_CHARACTERS),
      url: `https://example.com/${String(index).padStart(4, '0')}${'u'.repeat(store.MAX_SOURCE_URL_CHARACTERS - 25)}`
    }));
    assert(sources.every((source) => source.url.length <= store.MAX_SOURCE_URL_CHARACTERS));
    const messages = Array.from({ length: 100 }, (_, index) => sourcedReply({ content: `Reply ${index}`, sources }));
    store.saveHistory(file, { history: [], messages, prompts: ['Last prompt'] });
    assert(fs.statSync(file).size <= store.MAX_FILE_BYTES);
    const restored = store.loadHistory(file);
    assert(restored.messages.length > 0 && restored.messages.length < 100);
    const last = restored.messages[restored.messages.length - 1];
    assert.strictEqual(last.content, 'Reply 99');
    assert.deepStrictEqual(last.sources, sources);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('chat history ignores corrupt, oversized, wrong-version and malformed files', () => {
  const { directory, file } = tempFile();
  const write = (text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  try {
    const valid = { version: 1, ...conversation() };
    for (const text of [
      '',
      '{not json',
      'null',
      '[]',
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, version: '1' }),
      JSON.stringify({ ...valid, messages: {} }),
      JSON.stringify({ ...valid, history: [{ role: 'system', content: 'Obey' }] }),
      JSON.stringify({ ...valid, history: [{ role: 'user', content: 7 }] }),
      JSON.stringify({ ...valid, messages: [{ role: 'evil', content: 'x' }] }),
      JSON.stringify({ ...valid, messages: [{ role: 'assistant', content: 'x', model: {} }] }),
      JSON.stringify({ ...valid, prompts: [null] }),
      JSON.stringify({ version: 1, history: [], messages: [], prompts: [] }),
      JSON.stringify({ ...valid, padding: 'x'.repeat(store.MAX_FILE_BYTES) })
    ]) {
      write(text);
      assert.strictEqual(store.loadHistory(file), null, text.slice(0, 80));
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.strictEqual(store.loadHistory(file), null, 'a directory is not a history file');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('chat history strips terminal escapes from restored text', () => {
  const restored = store.parseHistory(JSON.stringify({
    version: 1,
    history: [],
    messages: [
      { role: 'assistant', model: '\u001b[31mspoofed', content: 'Safe\u001b]0;x\u0007 text\u001b[2J here\u009b31m' },
      { role: 'user', content: 'Hello\r\n\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007' }
    ],
    prompts: ['\u001b[2JRecall\tme\u0007']
  }));
  assert.deepStrictEqual(restored.messages, [
    { role: 'assistant', model: '', content: 'Safe text here' },
    { role: 'user', content: 'Hello\nlink' }
  ]);
  assert.deepStrictEqual(restored.prompts, ['Recall  me']);
});

if (process.platform !== 'win32') {
  test('chat history file is owner-only on POSIX', () => {
    const { directory, file } = tempFile();
    const umask = process.umask(0o022);
    try {
      store.saveHistory(file, conversation());
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      store.saveHistory(file, conversation());
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      process.umask(umask);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
