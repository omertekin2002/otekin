'use strict';

const assert = require('assert');
const { PassThrough } = require('stream');
const {
  startLinearChat,
  prefersLinearChat,
  formatLinearReply,
  commandName,
  modelLabel
} = require('../lib/linear-chat');
const { prepareRequestMessages, assistantMessageFromResponse } = require('../lib/chat-client');

// Cursor movement, erase and alternate-screen sequences, plus any carriage return.
const REDRAW = /\u001b\[[0-9;?]*[A-HJK]|\u001b\[\?1049|\r/;
const SGR = /\u001b\[[0-9;]*m/;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Drives a session through PassThrough streams with fake chat services.
function session(requestChat, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let out = '';
  let err = '';
  output.on('data', (chunk) => { out += chunk.toString(); });
  error.on('data', (chunk) => { err += chunk.toString(); });
  const requests = [];
  const services = {
    prepareRequestMessages,
    assistantMessageFromResponse,
    ensureChatServiceAwake: options.ensureChatServiceAwake || (async () => ({ ok: true })),
    requestChat: (messages, opts) => {
      requests.push({ messages, opts });
      return requestChat(messages, opts, requests.length);
    }
  };
  const chat = startLinearChat(Object.assign({
    input,
    output,
    error,
    services,
    color: false,
    echo: true,
    saveImages: (response) => response
  }, options.start || {}));
  return {
    chat,
    input,
    requests,
    out: () => out,
    err: () => err,
    send: (text) => input.write(text),
    // Waits until the session is idle at a prompt again.
    idle: async (count = 1) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await tick(1);
        if (out.split('You: ').length - 1 >= count && out.endsWith('You: ')) return;
      }
      throw new Error(`Session never prompted ${count} times. Output:\n${out}`);
    }
  };
}

test('linear chat keeps follow-up context and prints each answer once with its sources', async () => {
  const s = session(async (messages, _opts, number) => ({
    message: `Answer ${number} [1].\n\nSources:\n1. [Example](https://example.com/${number})`,
    model: 'fixture-model',
    webSources: [{ title: 'Example', url: `https://example.com/${number}` }]
  }));
  s.send('Q1\n');
  s.send('Q2\n');
  s.input.end();
  await s.chat.finished;

  assert.strictEqual(s.requests.length, 2);
  assert.deepStrictEqual(s.requests[0].messages, [{ role: 'user', content: 'Q1' }]);
  const second = s.requests[1].messages;
  assert.deepStrictEqual(second.map((message) => [message.role, message.content.split('\n')[0]]), [
    ['user', 'Q1'], ['assistant', 'Answer 1 [1].'], ['user', 'Q2']
  ]);
  const out = s.out();
  assert.strictEqual(out.split('Answer 1 [1].').length - 1, 1);
  assert.strictEqual(out.split('Answer 2 [1].').length - 1, 1);
  assert.match(out, /You: Q1\nResearching…\nfixture-model:\nAnswer 1 \[1\]\.\n\nSources:\n1\. Example https:\/\/example\.com\/1\n\n/);
  assert.match(out, /Sources:\n1\. Example https:\/\/example\.com\/2\n/);
  assert.doesNotMatch(out, REDRAW);
  assert.doesNotMatch(out, SGR);
  assert.strictEqual(s.err(), '');
});

test('linear chat never prints streamed deltas and prints one line per tool', async () => {
  const s = session(async (_messages, opts) => {
    // An onDelta callback is never requested, so provisional text cannot reach the output.
    assert.strictEqual(opts.onDelta, undefined);
    const running = { id: 't1', tool: 'search_web', query: 'first\u001b[31m query', status: 'running' };
    opts.onActivity(running);
    opts.onActivity(running);
    opts.onActivity({ ...running, status: 'complete' });
    opts.onActivity({ id: 't2', tool: 'read_url', query: 'https://example.com', status: 'running' });
    opts.onActivity({ id: 't2', tool: 'read_url', query: 'https://example.com', status: 'error' });
    opts.onActivity({ id: 'bad', status: 'running' });
    return {
      message: 'Done.',
      toolActivity: [
        { id: 't1', tool: 'search_web', query: 'first query', status: 'complete' },
        { id: 't3', tool: 'http_get', query: 'api', status: 'complete' }
      ]
    };
  });
  s.send('Q\n');
  s.input.end();
  await s.chat.finished;
  const out = s.out();
  assert.match(out, /Researching…\nSearching: first query\nReading page: https:\/\/example\.com\nFetch data: api\nOTEKIN:\nDone\.\n/);
  assert.strictEqual(out.split('first query').length - 1, 1);
  assert.doesNotMatch(out, /\u001b/);
});

test('linear chat prints the wake-up notice at most once and only when waking is slow', async () => {
  const wake = deferred();
  const s = session(async () => ({ message: 'Awake.' }), {
    ensureChatServiceAwake: () => wake.promise,
    start: { wakeNoticeDelayMs: 5 }
  });
  s.send('Q\n');
  await tick(40);
  wake.resolve();
  s.input.end();
  await s.chat.finished;
  assert.strictEqual(s.out().split('Waking chat service…').length - 1, 1);

  const fast = session(async () => ({ message: 'Awake.' }), { start: { wakeNoticeDelayMs: 50 } });
  fast.send('Q\n');
  fast.input.end();
  await fast.chat.finished;
  assert.doesNotMatch(fast.out(), /Waking/);
});

test('linear chat reports errors safely and keeps the previous history', async () => {
  const s = session(async (_messages, _opts, number) => {
    if (number === 2) {
      throw Object.assign(new Error('Chat service is busy.\u001b]52;c;ZXZpbA==\u0007'), { requestId: 'req-42' });
    }
    if (number === 3) throw Object.assign(new Error('Bad id'), { requestId: 'bad id\u001b[2J' });
    return { message: `Answer ${number}.` };
  });
  s.send('Q1\nQ2\nQ3\nQ4\n');
  s.input.end();
  await s.chat.finished;
  assert.strictEqual(s.err(), 'Chat error: Chat service is busy. (Request ID: req-42)\nChat error: Bad id\n');
  assert.deepStrictEqual(s.requests[3].messages.map((message) => message.content), ['Q1', 'Answer 1.', 'Q4']);
  assert.match(s.out(), /Answer 4\./);
});

test('linear chat cancels a reply in flight and never prints the late reply', async () => {
  const late = deferred();
  /** @type {AbortSignal | null} */
  let signal = null;
  const s = session(async (_messages, opts, number) => {
    if (number === 1) {
      signal = opts.signal;
      // Ignores its signal on purpose: a late reply must still never be printed.
      return late.promise;
    }
    return { message: 'Second answer.' };
  });
  s.send('Q1\n');
  await tick(5);
  assert.strictEqual(s.requests.length, 1);
  s.chat.interrupt();
  assert(signal);
  assert.strictEqual(signal.aborted, true);
  await s.idle(2);
  assert.match(s.out(), /You: Q1\nResearching…\nCancelled\.\nYou: $/);
  late.resolve({ message: 'Late reply.' });
  await tick(5);
  s.send('Q2\n');
  s.input.end();
  await s.chat.finished;
  assert.doesNotMatch(s.out(), /Late reply/);
  assert.match(s.out(), /Second answer\./);
  // The cancelled turn is not part of the history.
  assert.deepStrictEqual(s.requests[1].messages, [{ role: 'user', content: 'Q2' }]);
  assert.strictEqual(s.err(), '');
});

test('linear chat ends on Ctrl+C or EOF while idle', async () => {
  const s = session(async () => ({ message: 'Unused.' }));
  await s.idle(1);
  s.chat.interrupt();
  await s.chat.finished;
  assert.strictEqual(s.requests.length, 0);
  assert(s.out().endsWith('You: \n'));
  s.chat.interrupt();

  const eof = session(async () => ({ message: 'Unused.' }));
  await eof.idle(1);
  eof.input.end();
  await eof.chat.finished;
  assert(eof.out().endsWith('You: \n'));
});

test('linear chat handles commands, // messages and blank lines', async () => {
  const s = session(async () => ({ message: 'Slash answer.' }));
  s.send('\n   \n/help\n/Nope\n/retry\n//text here\n/exit\nnever sent\n');
  await s.chat.finished;
  const out = s.out();
  assert.match(out, /Linear chat commands:\n {2}\/help/);
  assert.match(out, /\/exit, \/quit {2}End the chat/);
  assert.match(out, /Unknown command: \/nope\. Type \/help to see the commands\./);
  assert.match(out, /Unknown command: \/retry\. Type \/help to see the commands\./);
  assert.deepStrictEqual(s.requests.map((request) => request.messages.at(-1).content), ['/text here']);
  assert.doesNotMatch(out, /never sent/);

  const quit = session(async () => ({ message: 'Unused.' }));
  quit.send('/quit\n');
  await quit.chat.finished;
  assert.strictEqual(quit.requests.length, 0);
});

test('linear chat sends a first prompt before reading input', async () => {
  const s = session(async () => ({ message: 'First answer.' }), { start: { firstPrompt: 'first' } });
  s.input.end();
  await s.chat.finished;
  assert.deepStrictEqual(s.requests[0].messages, [{ role: 'user', content: 'first' }]);
  assert.match(s.out(), /You: first\nResearching…\nOTEKIN:\nFirst answer\.\n/);
});

test('linear chat sanitizes replies, sources and model labels', async () => {
  const s = session(async () => ({
    message: 'Safe\u001b[2J text\r\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007 [1].',
    model: 'evil\u001b[31m',
    webSources: [{ title: 'Title\u001b[1A\u0007 here', url: 'https://example.com/a' }, { title: 'Bad', url: 'javascript:alert(1)' }]
  }));
  s.send('Q\n');
  s.input.end();
  await s.chat.finished;
  const out = s.out();
  assert.doesNotMatch(out, /\u001b|\u0007|\r/);
  assert.match(out, /OTEKIN:\nSafe textlink \[1\]\./);
  // Titles lose their control characters; a javascript: URL is not printed.
  assert.match(out, /1\. Title\[1A here https:\/\/example\.com\/a\n2\. Bad\n/);
  assert.doesNotMatch(out, /javascript:/);
});

test('linear chat echoes questions without terminal controls but sends them as typed', async () => {
  const typed = 'clear\u001b[2J this \u001b]52;c;ZXZpbA==\u0007now';
  const s = session(async () => ({ message: 'Answer.' }), { start: { firstPrompt: 'first\u001b[1A' } });
  s.send(typed + '\n');
  s.input.end();
  await s.chat.finished;
  assert.doesNotMatch(s.out(), /\u001b|\u0007/);
  assert.match(s.out(), /You: first\n/);
  assert.match(s.out(), /You: clear this now\n/);
  assert.deepStrictEqual(s.requests.map((request) => request.messages.at(-1).content), ['first\u001b[1A', typed]);
});

test('linear chat colors only its labels, and only when asked to', async () => {
  const s = session(async () => ({ message: 'Plain.', model: 'm1' }), { start: { color: true } });
  s.send('Q\n');
  s.input.end();
  await s.chat.finished;
  assert.match(s.out(), /\u001b\[1mm1\u001b\[0m:/);
  assert.doesNotMatch(s.out(), REDRAW);

  const plain = startLinearChat({
    input: Object.assign(new PassThrough(), { isTTY: true }),
    output: new PassThrough(),
    services: {
      prepareRequestMessages,
      assistantMessageFromResponse,
      ensureChatServiceAwake: async () => ({ ok: true }),
      requestChat: async () => ({ message: 'Unused.' })
    }
  });
  plain.interrupt();
  await plain.finished;
});

test('linear chat helpers pick the mode, commands, labels and source list', () => {
  assert.strictEqual(prefersLinearChat({ stdinIsTTY: true, stdoutIsTTY: true, term: 'dumb' }), true);
  assert.strictEqual(prefersLinearChat({ stdinIsTTY: true, stdoutIsTTY: true, term: 'xterm' }), false);
  assert.strictEqual(prefersLinearChat({ stdinIsTTY: false, stdoutIsTTY: true, term: 'dumb' }), false);
  assert.strictEqual(prefersLinearChat({ stdinIsTTY: true, stdoutIsTTY: false, term: 'dumb' }), false);
  assert.strictEqual(prefersLinearChat({ stdinIsTTY: true, stdoutIsTTY: true, term: 'dumb', nonInteractive: true }), false);
  assert.strictEqual(commandName('/Help'), 'help');
  assert.strictEqual(commandName('//help'), null);
  assert.strictEqual(commandName('/help me'), null);
  assert.strictEqual(modelLabel({ model: ' gpt-x ' }), 'gpt-x');
  assert.strictEqual(modelLabel({ model: 'a b' }), 'OTEKIN');
  assert.strictEqual(formatLinearReply({ message: 'No sources.' }), 'No sources.');
});
