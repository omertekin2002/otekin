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
const { prepareRequestMessages, assistantMessageFromResponse } = require('../lib/chat-client');

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

test('linear chat /help lists /retry, /save and /copy', async () => {
  const s = session(async () => ({ message: 'Unused.' }));
  s.send('/help\n');
  s.input.end();
  await s.chat.finished;
  assert.match(s.out(), /\/retry +Send your last message again\n/);
  assert.match(s.out(), /\/save +Save the conversation as Markdown\n/);
  assert.match(s.out(), /\/copy +Copy the latest reply and its sources\n/);
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
  assert.strictEqual(s.err(), 'Chat error: Chat service is busy.\n');
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
    start: { interactive: true, saveDirectory: tempDirectory(), copy: () => clipboard.promise }
  });
  s.send('Q1\n');
  await s.idle(2);
  s.send('Q2\n');
  await tick(5);
  // /retry waits behind a slow /copy; by the time it runs, Q2 has its answer.
  s.send('/copy\n/retry\n');
  await tick(5);
  pending.resolve(cited(2));
  await tick(5);
  clipboard.resolve('pbcopy');
  s.input.end();
  await s.chat.finished;
  const contents = (request) => request.messages.map((message) => message.content.split('\n')[0]);
  // One request at a time: the retry replaced Q2's answer after it arrived.
  assert.strictEqual(s.requests.length, 3);
  assert.deepStrictEqual(contents(s.requests[2]), ['Q1', 'Answer 1 [1].', 'Q2']);
  assert.strictEqual(s.out().split('Answer 3 [1].').length - 1, 1);
  assert.doesNotMatch(s.out(), /A reply is on the way/);
});
