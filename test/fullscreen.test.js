'use strict';

const assert = require('assert');
const {PassThrough, Writable} = require('stream');
const {Terminal} = require('@xterm/headless');
const client = require('../lib/chat-client');

const LINKS = {
  website: 'https://example.com/website',
  linkedin: 'https://example.com/linkedin',
  cv: 'https://example.com/resume'
};

async function waitFor(check, message) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message || 'Terminal did not update in time.');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

async function terminalApp(options = {}) {
  const [{default: React}, {render}, {TerminalApp}] = await Promise.all([
    import('react'), import('ink'), import('../lib/fullscreen.mjs')
  ]);
  const columns = options.columns || 110;
  const rows = options.rows || 30;
  // A real PTY converts LF to CRLF. Emulate that output processing here.
  const emulator = new Terminal({cols: columns, rows, convertEol: true, allowProposedApi: true});
  let raw = '';
  const stdout = new Writable({write(chunk, _encoding, done) {
    raw += chunk.toString();
    emulator.write(chunk.toString(), done);
  }});
  Object.assign(stdout, {isTTY: true, columns, rows});
  const stdin = new PassThrough();
  const rawModes = [];
  Object.assign(stdin, {isTTY: true, setRawMode(value) {rawModes.push(value);}, ref() {}, unref() {}});
  const opened = [];
  const app = render(React.createElement(TerminalApp, {
    links: LINKS, version: 'test', openInBrowser: async url => opened.push(url), ...options
  }), {
    stdout, stdin, stderr: stdout, alternateScreen: true, interactive: true,
    exitOnCtrlC: false, incrementalRendering: true, maxFps: 60
  });
  const screen = () => Array.from({length: stdout.rows}, (_,index) =>
    emulator.buffer.active.getLine(index)?.translateToString(true) || '').join('\n');
  const type = async text => {
    const keys = text.includes('\u001b[200~') ? [text]
      : text.match(/\u001b\[[0-9;:]*[A-Za-z~]|\u001b[^[]|[\u0000-\u001f\u007f]|[^\u0000-\u001f\u007f]+/gu) || [];
    for (const key of keys) {
      stdin.write(key);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  };
  await waitFor(() => screen().includes('Ready when you are'));
  return {
    screen, type, opened, stdout, stdin, emulator, rawModes, raw: () => raw,
    async resize(width, height) {
      emulator.resize(width, height);
      stdout.columns = width;
      stdout.rows = height;
      stdout.emit('resize');
      await new Promise(resolve => setTimeout(resolve, 80));
    },
    async close() {
      app.unmount();
      await app.waitUntilExit();
      await new Promise(resolve => setTimeout(resolve, 30));
      stdin.destroy();
      stdout.destroy();
      emulator.dispose();
    }
  };
}

test('composer edits whole graphemes and keeps its cursor inside wrapped Unicode text', async () => {
  const {editDraft, layoutDraft, moveVertically, sanitizeInput} = await import('../lib/editor.mjs');
  const text = 'Ömer 👨‍👩‍👧‍👦';
  const edited = editDraft({text, cursor: text.length}, 'backspace');
  assert.deepStrictEqual(edited, {text: 'Ömer ', cursor: 5});
  assert.deepStrictEqual(editDraft({text: 'e\u0301!', cursor: 2}, 'left'), {text: 'e\u0301!', cursor: 0});
  assert.strictEqual(editDraft({text: '\nHello', cursor: 0}, 'home').cursor, 0);
  assert.strictEqual(sanitizeInput('a\u001b[2J\r\nb\t!'), 'a\nb  !');
  const layout = layoutDraft('界界界', 3, 4);
  assert.deepStrictEqual(layout.lines, ['界界', '界']);
  assert.deepStrictEqual(layout.caret, {row: 1, column: 2});
  assert.deepStrictEqual(layoutDraft('1234\nx', 4, 4).lines, ['1234', 'x']);
  assert.deepStrictEqual(moveVertically({text: 'one\ntwo', cursor: 6}, -1, 20), {text: 'one\ntwo', cursor: 2});
});

test('full-screen app fills an alternate buffer, resizes, and restores the terminal', async () => {
  const ui = await terminalApp();
  try {
    assert.strictEqual(ui.emulator.buffer.active.type, 'alternate');
    assert.strictEqual(ui.emulator.buffer.active.length, 30);
    assert.match(ui.screen(), /ÖMER TEKIN/);
    assert.match(ui.screen(), /Ask anything, or type \/ for commands/);
    assert.match(ui.screen().split('\n')[29], /Enter send/);
    const inputRow = ui.screen().split('\n').findIndex(line => line.includes('│ ›'));
    assert.strictEqual(ui.emulator.buffer.active.cursorY, inputRow);
    await ui.resize(52, 18);
    assert.doesNotMatch(ui.screen(), /WORKSPACE/);
    assert.match(ui.screen(), /›_ otekin/);
    assert.match(ui.screen().split('\n')[17], /Enter send/);
    await ui.resize(20, 6);
    assert.match(ui.screen(), /Resize to at least/);
    await ui.resize(110, 30);
    assert.match(ui.screen(), /WORKSPACE/);
    await ui.type('\u0003');
    await waitFor(() => ui.emulator.buffer.active.type === 'normal');
    assert(ui.rawModes.includes(true));
    assert.strictEqual(ui.rawModes[ui.rawModes.length - 1], false);
    assert.match(ui.raw(), /\u001b\[\?2004l/);
    assert.match(ui.raw(), /\u001b\[\?25h/);
  } finally {
    await ui.close();
  }
});

test('command palette, navigation, and profile links work without leaving the app', async () => {
  const ui = await terminalApp();
  try {
    await ui.type('/li');
    assert.match(ui.screen(), /Find me on LinkedIn/);
    await ui.type('\t');
    assert.match(ui.screen(), /│ › \/linkedin/);
    await ui.type('\r');
    await waitFor(() => ui.opened.length === 1);
    assert.deepStrictEqual(ui.opened, [LINKS.linkedin]);
    await ui.type('/profile\r');
    assert.match(ui.screen(), /About Ömer/);
    assert.match(ui.screen(), /Website   https:\/\/example.com/);
    await ui.type('/help\r');
    assert.match(ui.screen(), /Make yourself at home/);
    await ui.type('\t\u001b[B\r');
    assert.match(ui.screen(), /About Ömer/);
    await ui.type('/nonsense\r');
    assert.match(ui.screen(), /Unknown command: \/nonsense/);
  } finally {
    await ui.close();
  }
});

test('chat keeps the composer live, preserves drafts and context, and scrolls long replies', async () => {
  const requests = [];
  let reply;
  const services = {
    ...client,
    ensureChatServiceAwake: async () => {},
    requestChat(messages, options) {
      requests.push(messages);
      options.onActivity({id: 'search', tool: 'search_web', query: 'current news', status: 'running'});
      return new Promise(resolve => {reply = resolve;});
    }
  };
  const ui = await terminalApp({services});
  try {
    await ui.type('First question\r');
    await waitFor(() => requests.length === 1);
    await waitFor(() => ui.screen().includes('Searching'));
    assert.match(ui.screen(), /│ › Ask anything/);
    await ui.type('Next question');
    reply({message: Array.from({length: 50}, (_,index) => `Answer line ${index + 1}`).join('\n')});
    await waitFor(() => ui.screen().includes('Answer line 50'));
    assert.match(ui.screen(), /│ › Next question/);
    await ui.type('\u001b[5~');
    assert.doesNotMatch(ui.screen(), /Answer line 50/);
    assert.match(ui.screen(), /│ › Next question/);
    await ui.type('\u001b[1;5F');
    await ui.type('\r');
    await waitFor(() => requests.length === 2);
    assert.strictEqual(requests[1].length, 3);
    assert.strictEqual(requests[1][0].content, 'First question');
    assert.strictEqual(requests[1][1].role, 'assistant');
    assert.strictEqual(requests[1][2].content, 'Next question');
    reply({message: 'Follow-up answer.'});
    await waitFor(() => ui.screen().includes('Follow-up answer.'));
    await ui.type('\u001b[A');
    assert.match(ui.screen(), /│ › Next question/);
    await ui.type('\u001b[B');
    assert.match(ui.screen(), /│ › Ask anything/);
    await ui.type('/clear\r');
    await waitFor(() => ui.screen().includes("Hi, I'm Ömer"));
    await ui.type('Fresh question\r');
    await waitFor(() => requests.length === 3);
    assert.strictEqual(requests[2].length, 1);
    reply({message: 'Fresh answer.'});
    await waitFor(() => ui.screen().includes('Fresh answer.'));
  } finally {
    await ui.close();
  }
});

test('bracketed paste is edited as a draft and never submits embedded newlines', async () => {
  const requests = [];
  const ui = await terminalApp({services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => {requests.push(messages); return {message: 'Received.'};}
  }});
  try {
    await ui.type('\u001b[200~Hello\n界 👨‍👩‍👧‍👦\nworld\u001b[201~');
    assert.strictEqual(requests.length, 0);
    assert.match(ui.screen(), /Hello/);
    assert.match(ui.screen(), /world/);
    await ui.type('\r');
    await waitFor(() => ui.screen().includes('Received.'));
    assert.strictEqual(requests[0][0].content, 'Hello\n界 👨‍👩‍👧‍👦\nworld');
    await ui.type('one\u000atwo');
    await ui.type('\r');
    await waitFor(() => requests.length === 2);
    assert.strictEqual(requests[1][2].content, 'one\ntwo');
  } finally {
    await ui.close();
  }
});

test('cancelling a request keeps the app usable and cannot commit a stale reply', async () => {
  let signal;
  let rejectRequest;
  const requests = [];
  const ui = await terminalApp({services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat(messages, options) {
      requests.push(messages);
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        rejectRequest = reject;
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), {once: true});
      });
    }
  }});
  try {
    await ui.type('Cancel this\r');
    await waitFor(() => Boolean(signal));
    await ui.type('Keep this draft');
    await ui.type('\u001b');
    await waitFor(() => signal.aborted);
    await waitFor(() => ui.screen().includes('Cancelled.'));
    assert.match(ui.screen(), /│ › Keep this draft/);
    await ui.type('\r');
    await waitFor(() => requests.length === 2);
    assert.strictEqual(requests[1].length, 1);
    rejectRequest(Object.assign(new Error('Service unavailable'), {requestId: 'fixture-request'}));
    await waitFor(() => ui.screen().includes('fixture-request'));
    assert.match(ui.screen(), /CHAT ERROR/);
    assert.match(ui.screen(), /│ › Ask anything/);
  } finally {
    await ui.close();
  }
});
