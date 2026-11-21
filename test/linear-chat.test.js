'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const {
  startLinearChat,
  prefersLinearChat,
  formatLinearReply,
  commandName,
  modelLabel
} = require('../lib/linear-chat');
const { prepareRequestMessages, assistantMessageFromResponse, TRIMMED_CONTEXT_NOTICE, MAX_MESSAGES } = require('../lib/chat-client');
const chatHistory = require('../lib/chat-history');

// Cursor movement, erase and alternate-screen sequences, plus any carriage return.
const REDRAW = /\u001b\[[0-9;?]*[A-HJK]|\u001b\[\?1049|\r/;
const SGR = /\u001b\[[0-9;]*m/;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
// 2026-11-16 12:34:56 UTC, so saved file names and answer times are predictable.
const FIXED_NOW = Date.UTC(2026, 10, 16, 12, 34, 56);

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-linear-'));
}

function filesIn(directory) {
  return fs.readdirSync(directory).sort();
}

// A cited reply numbered after the request, with a source link of its own.
function cited(number) {
  return {
    message: `Answer ${number} [1].\n\nSources:\n1. [Example ${number}](https://example.com/${number})`,
    model: 'fixture-model',
    webSources: [{ title: `Example ${number}`, url: `https://example.com/${number}` }]
  };
}

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
  // Piped input runs questions in order, so no /retry hint; the request had been sent.
  assert.strictEqual(s.err(), 'Chat error: Chat service is busy. (Request ID: req-42) The chat service may have received your question.\n' +
    'Chat error: Bad id. The chat service may have received your question.\n');
  assert.deepStrictEqual(s.requests[3].messages.map((message) => message.content), ['Q1', 'Answer 1.', 'Q4']);
  assert.match(s.out(), /Answer 4\./);
});

test('linear chat says a question stopped at the wake-up check was not sent, and /retry sends it with its context', async () => {
  const directory = tempDirectory();
  try {
    let wakes = 0;
    const s = session(async (_messages, _opts, number) => cited(number), {
      ensureChatServiceAwake: async () => {
        wakes += 1;
        if (wakes === 2) throw Object.assign(new Error('Chat service did not wake up in time.'), { requestId: 'wake-9' });
        return { ok: true };
      },
      start: { interactive: true, saveDirectory: directory, now: () => FIXED_NOW }
    });
    s.send('Q1\n');
    await s.idle(2);
    s.send('Q2\n');
    await s.idle(3);
    // The wake-up check failed, so the gateway never saw Q2.
    assert.strictEqual(s.requests.length, 1);
    assert.strictEqual(s.err(), 'Chat error: Chat service did not wake up in time. (Request ID: wake-9) ' +
      'Your question was not sent. Type /retry to send it again.\n');
    s.send('/retry\n');
    await s.idle(4);
    s.send('/save\n');
    s.input.end();
    await s.chat.finished;
    assert.strictEqual(s.requests.length, 2);
    const contents = (request) => request.messages.map((message) => message.content.split('\n')[0]);
    assert.deepStrictEqual(contents(s.requests[1]), ['Q1', 'Answer 1 [1].', 'Q2']);
    const markdown = fs.readFileSync(path.join(directory, filesIn(directory)[0]), 'utf8');
    assert.match(markdown, /## You\n\nQ1\n\n## fixture-model · [^\n]+\n\nAnswer 1 \[1\]\.[\s\S]*## You\n\nQ2\n\n## fixture-model · [^\n]+\n\nAnswer 2 \[1\]\./);
    assert.strictEqual(markdown.split('## You\n').length - 1, 2);
    assert.doesNotMatch(markdown, /Chat error|not sent|\/retry/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat never claims a failed chat request was not sent, and /retry resends the same request', async () => {
  const directory = tempDirectory();
  try {
    const s = session(async (_messages, _opts, number) => {
      if (number === 2) {
        throw Object.assign(new Error('Chat generation is temporarily unavailable. Try again later.'), { requestId: 'gen-5' });
      }
      return cited(number);
    }, { start: { interactive: true, saveDirectory: directory, now: () => FIXED_NOW } });
    s.send('Q1\n');
    await s.idle(2);
    s.send('Q2\n');
    await s.idle(3);
    assert.strictEqual(s.requests.length, 2);
    assert.strictEqual(s.err(), 'Chat error: Chat generation is temporarily unavailable. Try again later. (Request ID: gen-5) ' +
      'The chat service may have received your question. Type /retry to send it again.\n');
    assert.doesNotMatch(s.err(), /not sent/);
    s.send('/retry\n');
    await s.idle(4);
    s.send('/save\n');
    s.input.end();
    await s.chat.finished;
    assert.strictEqual(s.requests.length, 3);
    assert.deepStrictEqual(s.requests[2].messages, s.requests[1].messages);
    const markdown = fs.readFileSync(path.join(directory, filesIn(directory)[0]), 'utf8');
    assert.match(markdown, /Answer 1 \[1\]\.[\s\S]*## You\n\nQ2\n\n## fixture-model · [^\n]+\n\nAnswer 3 \[1\]\./);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat piped input reports a wake-up failure without a /retry hint', async () => {
  const s = session(async () => ({ message: 'Unused.' }), {
    ensureChatServiceAwake: async () => { throw new Error('Unable to wake chat service.'); }
  });
  s.send('Q1\n');
  s.input.end();
  await s.chat.finished;
  assert.strictEqual(s.requests.length, 0);
  assert.strictEqual(s.err(), 'Chat error: Unable to wake chat service. Your question was not sent.\n');
});

test('linear chat cancelling during the wake-up check prints no error and sends nothing', async () => {
  const wake = deferred();
  const s = session(async () => ({ message: 'Unused.' }), {
    ensureChatServiceAwake: () => wake.promise,
    start: { interactive: true, wakeNoticeDelayMs: 1000 }
  });
  s.send('Q1\n');
  await tick(5);
  s.chat.interrupt();
  await s.idle(2);
  wake.resolve();
  s.input.end();
  await s.chat.finished;
  assert.strictEqual(s.requests.length, 0);
  assert.strictEqual(s.err(), '');
  assert.match(s.out(), /Cancelled\./);
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
  assert.match(out, /You: \/retry\nNothing to retry yet\. Send a message first\.\n/);
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

test('linear chat sends a first prompt that looks like a command as a question, then reads input', async () => {
  const s = session(async (_messages, _opts, number) => ({ message: `Answer ${number}.` }), { start: { firstPrompt: '/exit' } });
  s.send('Q2\n/exit\nnever sent\n');
  await s.chat.finished;
  // The command-line /exit is a question and the piped one after it still ends the session.
  assert.deepStrictEqual(s.requests.map((request) => request.messages.at(-1).content), ['/exit', 'Q2']);
  assert.deepStrictEqual(s.requests[1].messages.map((message) => message.content), ['/exit', 'Answer 1.', 'Q2']);
  assert.match(s.out(), /You: \/exit\nResearching…\nOTEKIN:\nAnswer 1\.\n\nYou: Q2\nResearching…\nOTEKIN:\nAnswer 2\.\n\nYou: \/exit\n$/);
  assert.doesNotMatch(s.out(), /never sent/);

  const directory = tempDirectory();
  try {
    // No command runs from the command line, and a leading // is sent as it was written.
    for (const firstPrompt of ['/help', '/retry', '/save', '/copy', '/quit', '/Nope', '//etc']) {
      const copied = [];
      const other = session(async () => ({ message: 'Answered.' }), {
        start: { firstPrompt, saveDirectory: directory, copy: async (text) => copied.push(text) }
      });
      other.input.end();
      await other.chat.finished;
      assert.deepStrictEqual(other.requests.map((request) => request.messages), [[{ role: 'user', content: firstPrompt }]]);
      assert.match(other.out(), /Researching…\nOTEKIN:\nAnswered\.\n/);
      assert.doesNotMatch(other.out(), /Linear chat commands:|Unknown command|Nothing to|Saved the conversation|clipboard/i);
      assert.deepStrictEqual(copied, []);
    }
    assert.deepStrictEqual(filesIn(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat retries a failed first prompt that looks like a command and saves it once', async () => {
  const directory = tempDirectory();
  try {
    const s = session(async (_messages, _opts, number) => {
      if (number === 1) throw new Error('Try again.');
      return cited(number);
    }, { start: { firstPrompt: '/exit', saveDirectory: directory, now: () => FIXED_NOW } });
    s.send('/retry\n/save\n/retry\n/save\n');
    s.input.end();
    await s.chat.finished;
    assert.strictEqual(s.err(), 'Chat error: Try again. The chat service may have received your question.\n');
    assert.deepStrictEqual(s.requests.map((request) => request.messages), Array(3).fill([{ role: 'user', content: '/exit' }]));
    // One save after each reply; file names do not sort in the order they were written.
    const answers = filesIn(directory).map((file) => {
      const markdown = fs.readFileSync(path.join(directory, file), 'utf8');
      assert.strictEqual(markdown.split('## You\n\n/exit\n').length - 1, 1);
      assert.strictEqual(markdown.split('## You\n').length - 1, 1);
      return markdown.match(/Answer \d \[1\]\./g);
    });
    assert.deepStrictEqual(answers.sort(), [['Answer 2 [1].'], ['Answer 3 [1].']]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat ignores an empty or blank first prompt', async () => {
  for (const firstPrompt of ['', ' \t ']) {
    const s = session(async () => ({ message: 'Unused.' }), { start: { firstPrompt } });
    await s.idle(1);
    s.input.end();
    await s.chat.finished;
    assert.strictEqual(s.requests.length, 0);
    assert.strictEqual(s.out().split('You: ').length - 1, 1);
    assert.doesNotMatch(s.out(), /Researching/);
  }
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

test('linear chat prints replies and sources without bidi overrides or zero-width characters', async () => {
  const s = session(async () => ({
    message: 'Answer \u202egnp.exe\u202c \u2067x\u2069\u200b [1] 👩\u200d💻.',
    webSources: [{ title: 'Title \u202eevil\u202c\ufeff', url: 'https://example.com/a' }]
  }));
  s.send('Q\n');
  s.input.end();
  await s.chat.finished;
  const out = s.out();
  assert.doesNotMatch(out, /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/);
  assert.match(out, /OTEKIN:\nAnswer gnp\.exe x \[1\] 👩\u200d💻\./);
  assert.match(out, /1\. Title evil https:\/\/example\.com\/a\n/);
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

  const plainInput = Object.assign(new PassThrough(), { isTTY: true });
  const plainOutput = new PassThrough();
  let plainText = '';
  plainOutput.on('data', (chunk) => { plainText += chunk.toString(); });
  const plain = startLinearChat({
    input: plainInput,
    output: plainOutput,
    services: {
      prepareRequestMessages,
      assistantMessageFromResponse,
      ensureChatServiceAwake: async () => ({ ok: true }),
      requestChat: async () => ({ message: 'Plain reply.' })
    }
  });
  plainInput.end('Q\n');
  await plain.finished;
  assert.match(plainText, /Plain reply\./);
  assert.doesNotMatch(plainText, SGR);
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

test('linear chat /help lists /retry, /save, /copy and /clear', async () => {
  const s = session(async () => ({ message: 'Unused.' }));
  s.send('/help\n');
  s.input.end();
  await s.chat.finished;
  assert.match(s.out(), /\/retry +Send your last message again\n/);
  assert.match(s.out(), /\/save +Save the conversation as Markdown\n/);
  assert.match(s.out(), /\/copy +Copy the latest reply and its sources\n/);
  assert.match(s.out(), /\/clear +Forget the conversation and its saved history\n/);
  assert.strictEqual(s.requests.length, 0);
});

test('linear chat /retry after a failed reply sends the same question and prints the reply once', async () => {
  const s = session(async (_messages, _opts, number) => {
    if (number === 1) throw new Error('Chat service is busy.');
    return { message: 'Retried answer.' };
  });
  s.send('Q1\n/retry\n');
  s.input.end();
  await s.chat.finished;
  assert.strictEqual(s.requests.length, 2);
  assert.deepStrictEqual(s.requests[0].messages, [{ role: 'user', content: 'Q1' }]);
  assert.deepStrictEqual(s.requests[1].messages, s.requests[0].messages);
  assert.strictEqual(s.err(), 'Chat error: Chat service is busy. The chat service may have received your question.\n');
  assert.strictEqual(s.out().split('Retried answer.').length - 1, 1);
  assert.match(s.out(), /You: \/retry\nResearching…\nOTEKIN:\nRetried answer\.\n/);
  assert.doesNotMatch(s.out(), REDRAW);
});

test('linear chat /retry after a cancelled reply sends the same question', async () => {
  const late = deferred();
  const s = session(async (_messages, _opts, number) => (number === 1 ? late.promise : { message: 'Second try.' }));
  s.send('Q1\n');
  await tick(5);
  s.chat.interrupt();
  await s.idle(2);
  s.send('/retry\n');
  s.input.end();
  await s.chat.finished;
  late.resolve({ message: 'Late.' });
  assert.strictEqual(s.requests.length, 2);
  assert.deepStrictEqual(s.requests[1].messages, [{ role: 'user', content: 'Q1' }]);
  assert.match(s.out(), /Cancelled\.\nYou: \/retry\nResearching…\nOTEKIN:\nSecond try\.\n/);
  assert.doesNotMatch(s.out(), /Late\./);
});

test('linear chat retries an unanswered question without duplicating it in saved transcripts', async () => {
  const directory = tempDirectory();
  try {
    const s = session(async (_messages, _opts, number) => {
      if (number < 3) throw new Error('Try again.');
      return cited(number);
    }, { start: { saveDirectory: directory, now: () => FIXED_NOW } });
    s.send('Q1\n/retry\n/retry\n/save\n/retry\n/save\n');
    s.input.end();
    await s.chat.finished;
    assert.strictEqual(s.requests.length, 4);
    for (const file of filesIn(directory)) {
      const markdown = fs.readFileSync(path.join(directory, file), 'utf8');
      assert.strictEqual(markdown.split('## You\n\nQ1\n').length - 1, 1);
      assert.match(markdown, /Answer [34] \[1\]\./);
    }
    assert.strictEqual(filesIn(directory).length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat /retry after a completed reply replaces that turn in history and in /save', async () => {
  const directory = tempDirectory();
  const s = session(async (_messages, _opts, number) => cited(number), {
    start: { saveDirectory: directory, now: () => FIXED_NOW }
  });
  s.send('Q1\nQ2\n/retry\n/save\nQ3\n');
  s.input.end();
  await s.chat.finished;
  const contents = (request) => request.messages.map((message) => message.content.split('\n')[0]);
  assert.strictEqual(s.requests.length, 4);
  // The retry resends Q2 with the earlier turns as context, minus the replaced turn.
  assert.deepStrictEqual(contents(s.requests[2]), ['Q1', 'Answer 1 [1].', 'Q2']);
  // The next follow-up carries only the new answer.
  assert.deepStrictEqual(contents(s.requests[3]), ['Q1', 'Answer 1 [1].', 'Q2', 'Answer 3 [1].', 'Q3']);
  const saved = filesIn(directory);
  assert.strictEqual(saved.length, 1);
  const markdown = fs.readFileSync(path.join(directory, saved[0]), 'utf8');
  assert.match(markdown, /## You\n\nQ2\n\n## fixture-model · [^\n]+\n\nAnswer 3 \[1\]\./);
  assert.doesNotMatch(markdown, /Answer 2/);
  assert.strictEqual(markdown.split('## You\n\nQ2\n').length - 1, 1);
});

test('linear chat keeps the previous answer when a replacing /retry fails or is cancelled', async () => {
  const directory = tempDirectory();
  const hanging = deferred();
  const s = session(async (_messages, _opts, number) => {
    if (number === 2) throw new Error('Retry failed.');
    if (number === 3) return hanging.promise;
    return cited(number);
  }, { start: { saveDirectory: directory, now: () => FIXED_NOW } });
  s.send('Q1\n/retry\n');
  await s.idle(3);
  s.send('/retry\n');
  await tick(5);
  assert.strictEqual(s.requests.length, 3);
  s.chat.interrupt();
  await s.idle(4);
  s.send('/save\nQ2\n');
  s.input.end();
  await s.chat.finished;
  hanging.resolve(cited(99));
  const contents = (request) => request.messages.map((message) => message.content.split('\n')[0]);
  // Both retries resent Q1 without its answer.
  assert.deepStrictEqual(contents(s.requests[1]), ['Q1']);
  assert.deepStrictEqual(contents(s.requests[2]), ['Q1']);
  // The follow-up still has the first answer as context.
  assert.deepStrictEqual(contents(s.requests[3]), ['Q1', 'Answer 1 [1].', 'Q2']);
  const markdown = fs.readFileSync(path.join(directory, filesIn(directory)[0]), 'utf8');
  assert.match(markdown, /## You\n\nQ1\n\n## fixture-model · [^\n]+\n\nAnswer 1 \[1\]\./);
  assert.doesNotMatch(markdown, /Retry failed|Cancelled|Answer 99/);
});

test('linear chat /retry while a reply is on the way sends nothing and says so', async () => {
  const pending = deferred();
  const s = session(async () => pending.promise, { start: { interactive: true } });
  s.send('Q1\n');
  await tick(5);
  s.send('/retry\n');
  await tick(5);
  assert.strictEqual(s.requests.length, 1);
  assert.match(s.out(), /Researching…\nYou: \/retry\nA reply is on the way\. Ctrl\+C cancels it, then \/retry sends it again\.\n$/);
  pending.resolve({ message: 'Only answer.' });
  await s.idle(1);
  s.input.end();
  await s.chat.finished;
  assert.strictEqual(s.requests.length, 1);
  assert.strictEqual(s.out().split('Only answer.').length - 1, 1);
  assert.match(s.out(), /OTEKIN:\nOnly answer\.\n\nYou: \n$/);
});

test('linear chat /save writes the questions and replies only, and nothing when there is nothing to save', async () => {
  const directory = tempDirectory();
  const s = session(async (_messages, opts, number) => {
    if (number === 2) throw new Error('Broken.');
    opts.onActivity({ id: 't1', tool: 'search_web', query: 'secret tool query', status: 'running' });
    return {
      ...cited(number),
      toolActivity: [{ id: 't2', tool: 'read_url', query: 'https://tool.example', status: 'complete' }]
    };
  }, { start: { saveDirectory: directory, now: () => FIXED_NOW } });
  s.send('/save\n');
  await s.idle(2);
  assert.match(s.out(), /You: \/save\nNothing to save yet\. Send a message first\.\n/);
  assert.deepStrictEqual(filesIn(directory), []);
  s.send('Q1\nQ2\n/save\n');
  s.input.end();
  await s.chat.finished;
  const saved = filesIn(directory);
  assert.strictEqual(saved.length, 1);
  assert.match(saved[0], /^otekin-chat-\d{8}-\d{6}\.md$/);
  const file = path.join(directory, saved[0]);
  assert(s.out().includes(`Saved the conversation to ${file}\n`));
  const markdown = fs.readFileSync(file, 'utf8');
  assert.match(markdown, /^# otekin chat · /);
  assert.match(markdown, /## You\n\nQ1\n\n## fixture-model · \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\nAnswer 1 \[1\]\.\n\nSources: \[\\\[1\\\] Example 1\]\(https:\/\/example\.com\/1\)\n/);
  assert.match(markdown, /## You\n\nQ2\n$/);
  assert.doesNotMatch(markdown, /secret tool query|tool\.example|Broken|Chat error|Researching/);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(s.out(), REDRAW);
});

test('linear chat /save prints its path without terminal controls and reports write failures by code', async () => {
  if (process.platform !== 'win32') {
    const parent = tempDirectory();
    const directory = path.join(parent, 'evil\u001b[2Jdir');
    fs.mkdirSync(directory);
    const s = session(async () => ({ message: 'Answer.' }), { start: { saveDirectory: directory, now: () => FIXED_NOW } });
    s.send('Q\n/save\n');
    s.input.end();
    await s.chat.finished;
    assert.strictEqual(filesIn(directory).length, 1);
    assert.doesNotMatch(s.out(), /\u001b/);
    assert.match(s.out(), /Saved the conversation to \S*evildir\/otekin-chat-\d{8}-\d{6}\.md\n/);
  }

  const missing = path.join(tempDirectory(), 'missing', 'nested');
  const s = session(async () => ({ message: 'Answer.' }), { start: { saveDirectory: missing } });
  s.send('Q\n/save\n');
  s.input.end();
  await s.chat.finished;
  assert.match(s.out(), /Could not save the conversation \(ENOENT\)\. The chat still works\.\n/);
  assert(!s.out().includes(missing));
});

test('linear chat /copy copies the latest reply, falls back to a file and says when there is nothing', async () => {
  const directory = tempDirectory();
  /** @type {string[]} */
  const copied = [];
  /** @type {unknown} */
  let result = 'xclip';
  const s = session(async (_messages, _opts, number) => cited(number), {
    start: {
      saveDirectory: directory,
      now: () => FIXED_NOW,
      copy: async (text) => {
        copied.push(text);
        if (result instanceof Error) throw result;
        return result;
      }
    }
  });
  s.send('/copy\n');
  await s.idle(2);
  assert.match(s.out(), /You: \/copy\nNothing to copy yet\. Wait for a reply to finish\.\n/);
  assert.deepStrictEqual(copied, []);

  s.send('Q1\nQ2\n/copy\n');
  await s.idle(5);
  assert.deepStrictEqual(copied, ['Answer 2 [1].\n\nSources: [\\[1\\] Example 2](https://example.com/2)\n']);
  assert.match(s.out(), /You: \/copy\nCopied the latest reply \(with 1 source\) to the clipboard\n/);
  assert.deepStrictEqual(filesIn(directory), []);

  result = null;
  s.send('/copy\n');
  await s.idle(6);
  result = new Error('spawn failed');
  s.send('/copy\n');
  s.input.end();
  await s.chat.finished;
  const saved = filesIn(directory);
  assert.strictEqual(saved.length, 2);
  saved.forEach((name) => assert.match(name, /^otekin-reply-\d{8}-\d{6}(-2)?\.md$/));
  for (const name of saved) {
    assert.strictEqual(fs.readFileSync(path.join(directory, name), 'utf8'), copied[1]);
    assert(s.out().includes(`No clipboard available; saved the latest reply (with 1 source) to ${path.join(directory, name)}\n`));
  }
  assert.doesNotMatch(s.out(), REDRAW);
});

test('linear chat commands typed during a reply answer at once without breaking the reply', async () => {
  const directory = tempDirectory();
  const pending = deferred();
  /** @type {string[]} */
  const copied = [];
  const s = session(async (_messages, _opts, number) => (number === 2 ? pending.promise : cited(number)), {
    start: {
      interactive: true,
      saveDirectory: directory,
      now: () => FIXED_NOW,
      copy: async (text) => {
        copied.push(text);
        return 'pbcopy';
      }
    }
  });
  s.send('Q1\n');
  await s.idle(2);
  s.send('Q2\n');
  await tick(5);
  s.send('/copy\n/save\n/help\n');
  await tick(5);
  // The reply on its way is never copied; the latest completed one is, and the message says so.
  assert.deepStrictEqual(copied, ['Answer 1 [1].\n\nSources: [\\[1\\] Example 1](https://example.com/1)\n']);
  assert.match(s.out(), /Copied the previous reply \(with 1 source\) to the clipboard\. The reply being written is not finished yet\n/);
  assert.match(s.out(), /Saved the conversation to /);
  assert.match(s.out(), /Linear chat commands:/);
  assert.strictEqual(s.requests.length, 2);
  pending.resolve(cited(2));
  await s.idle(3);
  s.input.end();
  await s.chat.finished;
  const out = s.out();
  // The reply arrives whole after the commands' lines.
  assert.match(out, /Ctrl\+D +End the chat when idle\nfixture-model:\nAnswer 2 \[1\]\.\n\nSources:\n1\. Example 2 https:\/\/example\.com\/2\n\nYou: \n$/);
  assert.strictEqual(out.split('Answer 2 [1].').length - 1, 1);
  assert.doesNotMatch(out, REDRAW);
  // Piped lines wait their turn instead.
  const piped = session(async (_messages, _opts, number) => cited(number), {
    start: { saveDirectory: tempDirectory(), copy: async () => 'pbcopy' }
  });
  piped.send('Q1\n/copy\n');
  piped.input.end();
  await piped.chat.finished;
  assert.match(piped.out(), /Copied the latest reply \(with 1 source\) to the clipboard\n/);
});

test('linear chat prints a late clipboard result on its own line after the prompt returns', async () => {
  const pending = deferred();
  const clipboard = deferred();
  const s = session(async (_messages, _opts, number) => (number === 2 ? pending.promise : cited(number)), {
    start: { interactive: true, saveDirectory: tempDirectory(), copy: () => clipboard.promise }
  });
  s.send('Q1\n');
  await s.idle(2);
  s.send('Q2\n');
  await tick(5);
  s.send('/copy\n');
  await tick(5);
  pending.resolve(cited(2));
  await s.idle(3);
  clipboard.resolve('xsel');
  await tick(5);
  assert.match(s.out(), /\n\nYou: \nCopied the previous reply \(with 1 source\) to the clipboard\. The reply being written is not finished yet\nYou: $/);
  s.input.end();
  await s.chat.finished;
});

test('linear chat runs a /retry typed during a reply in turn once that reply has finished', async () => {
  const pending = deferred();
  const clipboard = deferred();
  const s = session(async (_messages, _opts, number) => (number === 2 ? pending.promise : cited(number)), {
    start: { interactive: true, saveDirectory: tempDirectory(), now: () => FIXED_NOW, copy: () => clipboard.promise }
  });
  s.send('Q1\n');
  await s.idle(2);
  s.send('Q2\n');
  await tick(5);
  // /retry and /save wait behind a slow /copy; by the time they run, Q2 has its answer.
  s.send('/copy\n/retry\n/save\n');
  await tick(5);
  pending.resolve(cited(2));
  await tick(5);
  // The input ends before the clipboard settles: the waiting commands still run.
  let finished = false;
  s.chat.finished.then(() => { finished = true; });
  s.input.end();
  await tick(5);
  assert.strictEqual(finished, false);
  clipboard.resolve('pbcopy');
  await s.chat.finished;
  assert.match(s.out(), /Saved the conversation to /);
  assert(s.out().endsWith('\n'));
  const contents = (request) => request.messages.map((message) => message.content.split('\n')[0]);
  // One request at a time: the retry replaced Q2's answer after it arrived.
  assert.strictEqual(s.requests.length, 3);
  assert.deepStrictEqual(contents(s.requests[2]), ['Q1', 'Answer 1 [1].', 'Q2']);
  assert.strictEqual(s.out().split('Answer 3 [1].').length - 1, 1);
  assert.doesNotMatch(s.out(), /A reply is on the way/);
});

// A history file in a fresh directory, removed by the caller.
function historyFixture() {
  const directory = tempDirectory();
  return { directory, file: path.join(directory, 'state', 'history.json') };
}

// Saves a conversation as the full-screen chat would: one cited, timed reply and a tool line.
function saveFullScreenConversation(file) {
  const response = cited(1);
  const history = prepareRequestMessages([], 'Saved question').concat(assistantMessageFromResponse(response));
  chatHistory.saveHistory(file, {
    history,
    messages: [
      { role: 'user', content: 'Saved question' },
      { role: 'tools', content: '✓ Searched  saved query' },
      {
        role: 'assistant',
        model: 'fixture-model',
        answeredAt: '2026-11-15T09:30:00.000Z',
        content: 'Answer 1 [1].\n\nSources: [1] Example 1',
        answer: 'Answer 1 [1].',
        sources: [{ number: 1, title: 'Example 1', url: 'https://example.com/1' }]
      }
    ],
    prompts: ['Saved question']
  });
  return history;
}

// An interactive session (a person typing) using a saved history file.
function historySession(requestChat, file, start = {}) {
  return session(requestChat, { start: { interactive: true, historyFile: file, now: () => FIXED_NOW, ...start } });
}

test('linear chat continues a saved conversation with one line and its context', async () => {
  const { directory, file } = historyFixture();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  try {
    saveFullScreenConversation(file);
    // The same request the full-screen chat would send.
    const expected = prepareRequestMessages(chatHistory.loadHistory(file).history, 'Follow up');
    const s = historySession(async (_messages, _opts, number) => cited(number + 1), file, { saveDirectory });
    s.send('Follow up\n');
    await s.idle(2);
    s.send('/save\n');
    s.input.end();
    await s.chat.finished;
    const out = s.out();
    assert.strictEqual(out.split('Continuing your saved conversation').length - 1, 1);
    assert.match(out, /^otekin linear chat.*\n.*\nContinuing your saved conversation \(1 question\)\. \/clear forgets it; --no-history skips it\.\nYou: /);
    // The old reply is not printed again.
    assert.strictEqual(out.split('Answer 1 [1].').length - 1, 0);
    assert.deepStrictEqual(s.requests[0].messages, expected);
    assert.strictEqual(s.requests[0].messages[1].webSources[0].url, 'https://example.com/1');
    const [saved] = filesIn(saveDirectory);
    const markdown = fs.readFileSync(path.join(saveDirectory, saved), 'utf8');
    assert.match(markdown, /## You\n\nSaved question\n\n## fixture-model · 2026-11-15 \d{2}:30\n\nAnswer 1 \[1\]\.\n\nSources: \[\\\[1\\\] Example 1\]\(https:\/\/example\.com\/1\)\n\n## You\n\nFollow up\n\n## fixture-model · /);
    assert.doesNotMatch(markdown, /saved query/);
    assert.strictEqual(s.err(), '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat saves each completed reply where the next session finds it', async () => {
  const { directory, file } = historyFixture();
  try {
    const first = historySession(async (_messages, _opts, number) => cited(number), file);
    first.send('Q1\n//slash question\n');
    first.input.end();
    await first.chat.finished;
    assert.doesNotMatch(first.out(), /Continuing/);
    const saved = chatHistory.loadHistory(file);
    assert(saved);
    assert.deepStrictEqual(saved.history.map((message) => [message.role, message.content.split('\n')[0]]), [
      ['user', 'Q1'], ['assistant', 'Answer 1 [1].'], ['user', '/slash question'], ['assistant', 'Answer 2 [1].']
    ]);
    assert.deepStrictEqual(saved.prompts, ['Q1', '//slash question']);
    const reply = saved.messages[1];
    assert.strictEqual(reply.role, 'assistant');
    assert.strictEqual(reply.model, 'fixture-model');
    assert.strictEqual(reply.content, 'Answer 1 [1].\n\nSources: [1] Example 1');
    assert.strictEqual(reply.answer, 'Answer 1 [1].');
    assert.deepStrictEqual(reply.sources, [{ number: 1, title: 'Example 1', url: 'https://example.com/1' }]);
    assert.strictEqual(reply.answeredAt, new Date(FIXED_NOW).toISOString());

    const second = historySession(async (_messages, _opts, number) => cited(number + 2), file);
    second.send('Q3\n');
    second.input.end();
    await second.chat.finished;
    assert.match(second.out(), /Continuing your saved conversation \(2 questions\)\./);
    assert.deepStrictEqual(second.requests[0].messages.map((message) => message.content.split('\n')[0]),
      ['Q1', 'Answer 1 [1].', '/slash question', 'Answer 2 [1].', 'Q3']);
    assert.deepStrictEqual(chatHistory.loadHistory(file).prompts, ['Q1', '//slash question', 'Q3']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat saves a command-line prompt so recalling it asks it again', async () => {
  const { directory, file } = historyFixture();
  try {
    const s = historySession(async () => ({ message: 'About exit.' }), file, { firstPrompt: '/exit' });
    s.input.end();
    await s.chat.finished;
    assert.deepStrictEqual(chatHistory.loadHistory(file).prompts, ['//exit']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat saves a replacing /retry in place, and never a failed or cancelled reply', async () => {
  const { directory, file } = historyFixture();
  try {
    const late = deferred();
    const s = historySession(async (_messages, _opts, number) => {
      if (number === 2) throw new Error('Busy.');
      if (number === 3) return late.promise;
      return cited(number);
    }, file);
    s.send('Q1\n');
    await s.idle(2);
    const before = fs.readFileSync(file);
    s.send('/retry\n');
    await s.idle(3);
    assert.deepStrictEqual(fs.readFileSync(file), before, 'a failed retry leaves the file as it was');
    s.send('/retry\n');
    await tick(5);
    s.chat.interrupt();
    await s.idle(4);
    late.resolve(cited(3));
    await tick(5);
    assert.deepStrictEqual(fs.readFileSync(file), before, 'a cancelled retry leaves the file as it was');
    s.send('/retry\n');
    s.input.end();
    await s.chat.finished;
    const saved = chatHistory.loadHistory(file);
    assert.deepStrictEqual(saved.history.map((message) => message.content.split('\n')[0]), ['Q1', 'Answer 4 [1].']);
    assert.deepStrictEqual(saved.messages.map((message) => [message.role, message.content.split('\n')[0]]),
      [['user', 'Q1'], ['assistant', 'Answer 4 [1].']]);
    assert.deepStrictEqual(saved.prompts, ['Q1']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat replaces a restored last turn with /retry', async () => {
  const { directory, file } = historyFixture();
  try {
    saveFullScreenConversation(file);
    const s = historySession(async () => cited(9), file);
    s.send('/retry\n');
    s.input.end();
    await s.chat.finished;
    assert.deepStrictEqual(s.requests[0].messages, [{ role: 'user', content: 'Saved question' }]);
    const saved = chatHistory.loadHistory(file);
    assert.deepStrictEqual(saved.messages.map((message) => [message.role, message.content.split('\n')[0]]),
      [['user', 'Saved question'], ['assistant', 'Answer 9 [1].']]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat never reads or writes history when piped or with history off', async () => {
  const calls = [];
  const historyStore = {
    loadHistory: (file) => { calls.push(['load', file]); return null; },
    saveHistory: (file) => { calls.push(['save', file]); },
    clearHistory: (file) => { calls.push(['clear', file]); }
  };
  // Piped input: a file is given, but the session is not interactive.
  const piped = session(async () => ({ message: 'Piped.' }), {
    start: { interactive: false, historyFile: '/unused/history.json', historyStore }
  });
  piped.send('Q1\n/clear\nQ2\n');
  piped.input.end();
  await piped.chat.finished;
  // History off: no file.
  const off = session(async () => ({ message: 'Off.' }), { start: { interactive: true, historyFile: null, historyStore } });
  off.send('Q1\n/clear\n');
  off.input.end();
  await off.chat.finished;
  assert.deepStrictEqual(calls, []);
  assert.doesNotMatch(piped.out() + off.out(), /Continuing|Could not save/);
  assert.match(piped.out(), /You: \/clear\nConversation cleared\n/);
  assert.deepStrictEqual(piped.requests[1].messages, [{ role: 'user', content: 'Q2' }]);
});

test('linear chat /clear forgets the conversation, its prompts and the saved file', async () => {
  const { directory, file } = historyFixture();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  try {
    saveFullScreenConversation(file);
    const s = historySession(async (_messages, _opts, number) => cited(number), file, { saveDirectory });
    s.send('/clear\n');
    await s.idle(2);
    assert.match(s.out(), /You: \/clear\nConversation cleared\n/);
    assert.strictEqual(fs.existsSync(file), false);
    s.send('/save\n/copy\n/retry\n');
    await s.idle(5);
    assert.match(s.out(), /Nothing to save yet\. Send a message first\./);
    assert.match(s.out(), /Nothing to copy yet\./);
    assert.match(s.out(), /Nothing to retry yet\./);
    assert.deepStrictEqual(filesIn(saveDirectory), []);
    s.send('Fresh\n');
    s.input.end();
    await s.chat.finished;
    assert.deepStrictEqual(s.requests[0].messages, [{ role: 'user', content: 'Fresh' }]);
    const saved = chatHistory.loadHistory(file);
    assert.deepStrictEqual(saved.prompts, ['Fresh']);
    assert.deepStrictEqual(saved.messages.map((message) => message.role), ['user', 'assistant']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat /clear cancels a reply on the way and forgets its question', async () => {
  const { directory, file } = historyFixture();
  try {
    const late = deferred();
    /** @type {AbortSignal | null} */
    let signal = null;
    const s = historySession(async (_messages, opts, number) => {
      if (number === 2) {
        signal = opts.signal;
        return late.promise;
      }
      return cited(number);
    }, file);
    s.send('Q1\n');
    await s.idle(2);
    s.send('Q2\n');
    await tick(5);
    s.send('/clear\n');
    await tick(5);
    assert(signal);
    assert.strictEqual(signal.aborted, true);
    assert.strictEqual(fs.existsSync(file), false);
    late.resolve(cited(2));
    await tick(5);
    s.send('/retry\nQ3\n');
    s.input.end();
    await s.chat.finished;
    assert.doesNotMatch(s.out(), /Answer 2/);
    assert.match(s.out(), /Nothing to retry yet\./);
    assert.deepStrictEqual(s.requests[2].messages, [{ role: 'user', content: 'Q3' }]);
    assert.deepStrictEqual(chatHistory.loadHistory(file).prompts, ['Q3']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('linear chat reports history save and delete failures in one line and keeps working', async () => {
  const saves = [];
  const historyStore = {
    loadHistory: () => null,
    saveHistory: (_file, state) => {
      saves.push(state);
      throw Object.assign(new Error('EACCES: permission denied, open /secret/path/history.json'), { code: 'EACCES' });
    },
    clearHistory: () => {
      throw Object.assign(new Error('EPERM: /secret/path'), { code: 'EPERM' });
    }
  };
  const s = session(async (_messages, _opts, number) => cited(number), {
    start: { interactive: true, historyFile: '/secret/path/history.json', historyStore }
  });
  s.send('Q1\nQ2\n');
  await s.idle(3);
  s.send('/clear\n');
  s.input.end();
  await s.chat.finished;
  const out = s.out();
  assert.strictEqual(out.split('Could not save chat history (EACCES). The chat still works.\n').length - 1, 2);
  assert.match(out, /You: \/clear\nConversation cleared, but the saved history could not be deleted\n/);
  assert.doesNotMatch(out + s.err(), /secret|permission denied/);
  assert.match(out, /Answer 2 \[1\]\./);
  assert.strictEqual(saves.length, 2);
  assert.deepStrictEqual(saves[1].history.map((message) => message.content.split('\n')[0]),
    ['Q1', 'Answer 1 [1].', 'Q2', 'Answer 2 [1].']);
  assert.deepStrictEqual(saves[1].prompts, ['Q1', 'Q2']);
});

test('linear chat ignores a history store that cannot load', async () => {
  const historyStore = {
    loadHistory: () => { throw new Error('broken'); },
    saveHistory: () => {},
    clearHistory: () => {}
  };
  const s = session(async () => ({ message: 'Fine.' }), { start: { interactive: true, historyFile: '/x/history.json', historyStore } });
  s.send('Q1\n');
  s.input.end();
  await s.chat.finished;
  assert.doesNotMatch(s.out(), /Continuing/);
  assert.deepStrictEqual(s.requests[0].messages, [{ role: 'user', content: 'Q1' }]);
});

// How often the notice that follow-ups leave out older turns was printed.
const trimNotices = (out) => out.split(TRIMMED_CONTEXT_NOTICE).length - 1;
const questions = (from, to) => Array.from({ length: to - from + 1 }, (_value, index) => `Q${from + index}\n`).join('');

test('linear chat says once, before Researching, when a follow-up first leaves out older turns', async () => {
  const saveDirectory = tempDirectory();
  try {
    // 14 answered turns and the 15th question fit in MAX_MESSAGES; 15 turns and the 16th question do not.
    assert.strictEqual(MAX_MESSAGES, 30);
    const s = session(async (_messages, _opts, number) => ({ message: `Answer ${number}.` }),
      { start: { saveDirectory } });
    s.send(questions(1, 15));
    await s.idle(16);
    assert.strictEqual(trimNotices(s.out()), 0, 'every request so far carried every earlier turn');
    s.send(questions(16, 20) + '/retry\n/save\n');
    s.input.end();
    await s.chat.finished;
    const out = s.out();
    assert.strictEqual(trimNotices(out), 1);
    assert(out.includes(`You: Q16\n${TRIMMED_CONTEXT_NOTICE}\nResearching…\n`), out);
    assert.strictEqual(s.requests[14].messages[0].content, 'Q1');
    assert.strictEqual(s.requests[15].messages[0].content, 'Q2', 'the 16th request is the first to drop a turn');
    assert.strictEqual(s.requests.length, 21);
    for (const request of s.requests) {
      assert(request.messages.every((message) => !message.content.includes(TRIMMED_CONTEXT_NOTICE)));
    }
    const [saved] = filesIn(saveDirectory);
    const markdown = fs.readFileSync(path.join(saveDirectory, saved), 'utf8');
    assert.match(markdown, /## You\n\nQ1\n/);
    assert.doesNotMatch(markdown, /follow-ups now send/);
    assert.strictEqual(s.err(), '');
  } finally {
    fs.rmSync(saveDirectory, { recursive: true, force: true });
  }
});

test('linear chat never prints the trim notice while requests carry every earlier turn', async () => {
  const s = session(async (_messages, _opts, number) => ({ message: `Answer ${number}.` }));
  // A replacing /retry of the 15th turn sends the same 14 earlier turns.
  s.send(questions(1, 15) + '/retry\n');
  s.input.end();
  await s.chat.finished;
  assert.strictEqual(s.requests.length, 16);
  assert.strictEqual(s.requests[15].messages.length, MAX_MESSAGES - 1);
  assert.strictEqual(trimNotices(s.out()), 0);
});

test('linear chat prints the trim notice again after /clear, for a typed or piped session', async () => {
  for (const interactive of [false, true]) {
    const s = session(async (_messages, _opts, number) => ({ message: `Answer ${number}.` }), { start: { interactive } });
    s.send(questions(1, 17));
    await s.idle(18);
    assert.strictEqual(trimNotices(s.out()), 1);
    s.send('/clear\n' + questions(1, 15));
    await s.idle(34);
    assert.strictEqual(trimNotices(s.out()), 1, 'the new conversation still carries every turn');
    s.send(questions(16, 17));
    s.input.end();
    await s.chat.finished;
    assert.strictEqual(trimNotices(s.out()), 2, `interactive: ${interactive}`);
    const afterClear = s.out().slice(s.out().indexOf('Conversation cleared'));
    assert.match(afterClear, /You: Q16\nOlder turns stay on screen/);
  }
});

test('linear chat says follow-ups leave out older turns on the first follow-up of a restored conversation', async () => {
  const { directory, file } = historyFixture();
  try {
    // The transcript shows ten turns; the saved request history kept only the last two.
    const messages = [];
    for (let index = 1; index <= 10; index += 1) {
      messages.push({ role: 'user', content: `Old ${index}` }, { role: 'assistant', model: 'fixture-model', content: `Old answer ${index}` });
    }
    const history = messages.slice(-4).map(({ role, content }) => ({ role, content }));
    chatHistory.saveHistory(file, { history, messages, prompts: [] });
    const s = historySession(async (_messages, _opts, number) => ({ message: `Answer ${number}.` }), file);
    s.send('Follow up\n');
    await s.idle(2);
    s.send('/retry\nAnother\n');
    s.input.end();
    await s.chat.finished;
    const out = s.out();
    assert.strictEqual(trimNotices(out), 1);
    assert.match(out, /You: Follow up\nOlder turns stay on screen/);
    assert.deepStrictEqual(s.requests[0].messages.map((message) => message.content),
      ['Old 9', 'Old answer 9', 'Old 10', 'Old answer 10', 'Follow up']);
    const saved = chatHistory.loadHistory(file);
    assert(saved.messages.every((message) => !message.content.includes(TRIMMED_CONTEXT_NOTICE)));
    assert(saved.history.every((message) => !message.content.includes(TRIMMED_CONTEXT_NOTICE)));

    // A new session over the same saved conversation says it again.
    const next = historySession(async () => ({ message: 'Later.' }), file);
    next.send('Again\n');
    next.input.end();
    await next.chat.finished;
    assert.strictEqual(trimNotices(next.out()), 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
