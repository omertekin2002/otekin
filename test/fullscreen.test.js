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

test('scrolled-up conversations stay in place while research and replies arrive', async () => {
  let reply;
  let activity;
  const ui = await terminalApp({services: {
    ...client,
    ensureChatServiceAwake: async () => {},
    requestChat(_messages, options) {
      activity = options.onActivity;
      return new Promise(resolve => {reply = resolve;});
    }
  }});
  const viewport = () => ui.screen().split('\n').slice(2, 25).join('\n');
  const linesBelow = () => Number((ui.screen().match(/↑ (\d+) lines/) || [])[1] || 0);
  try {
    await ui.type('First question\r');
    await waitFor(() => Boolean(reply));
    reply({message: Array.from({length: 50}, (_,index) => `Answer line ${index + 1}`).join('\n')});
    await waitFor(() => ui.screen().includes('Answer line 50'));
    reply = null;
    await ui.type('Second question\r');
    await waitFor(() => Boolean(reply));
    await ui.type('\u001b[5~');
    const before = viewport();
    const below = linesBelow();
    assert.match(before, /Answer line/);
    assert(below > 0);
    activity({id: 'search', tool: 'search_web', query: 'current news', status: 'running'});
    await waitFor(() => linesBelow() > below);
    assert.strictEqual(viewport(), before);
    reply({message: Array.from({length: 10}, (_,index) => `Second answer ${index + 1}`).join('\n')});
    await waitFor(() => linesBelow() > below + 10);
    assert.strictEqual(viewport(), before);
    await ui.type('\u001b[1;5F');
    assert.match(ui.screen(), /Second answer 10/);
    assert.doesNotMatch(ui.screen(), /↑ \d+ lines/);
  } finally {
    await ui.close();
  }
});

test('scrolled-up conversations stay in place when cancelling removes research lines', async () => {
  let activity;
  let signal;
  let calls = 0;
  const ui = await terminalApp({services: {
    ...client,
    ensureChatServiceAwake: async () => {},
    async requestChat(_messages, options) {
      calls += 1;
      if (calls === 1) return {message: Array.from({length: 50}, (_,index) => `Answer line ${index + 1}`).join('\n')};
      activity = options.onActivity;
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), {once: true});
      });
    }
  }});
  const viewport = () => ui.screen().split('\n').slice(2, 25).join('\n');
  try {
    await ui.type('First question\r');
    await waitFor(() => ui.screen().includes('Answer line 50'));
    await ui.type('Second question\r');
    await waitFor(() => Boolean(activity));
    for (let index = 0; index < 20; index += 1) {
      activity({id: `read-${index}`, tool: 'read_url', url: `https://example.com/${index}`, status: 'running'});
    }
    await ui.type('\u001b[1;5H');
    const before = viewport();
    assert.match(before, /First question/);
    await ui.type('\u001b');
    await waitFor(() => signal.aborted && ui.screen().includes('Cancelled.'));
    assert.strictEqual(viewport(), before);
  } finally {
    await ui.close();
  }
});

test('slash-prefixed text is sent as chat unless it is a single command word', async () => {
  const requests = [];
  const models = ['gpt-6.1-sol', undefined, '\u001b[31mspoofed'];
  const ui = await terminalApp({columns: 80, services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => {
      requests.push(messages);
      return {message: `Reply ${requests.length}.`, model: models[requests.length - 1]};
    }
  }});
  try {
    await ui.type('/r/law is debating this\r');
    await waitFor(() => ui.screen().includes('Reply 1.'));
    assert.strictEqual(requests[0][0].content, '/r/law is debating this');
    assert.match(ui.screen(), /gpt-6\.1-sol\n\s*Reply 1\./);
    await ui.type('//etc\r');
    await waitFor(() => ui.screen().includes('Reply 2.'));
    assert.strictEqual(requests[1][2].content, '/etc');
    assert.match(ui.screen(), /OTEKIN\n\s*Reply 2\./);
    await ui.type('\u001b[A');
    assert.match(ui.screen(), /│ › \/\/etc/);
    await ui.type('\u0015Third\r');
    await waitFor(() => ui.screen().includes('Reply 3.'));
    assert.match(ui.screen(), /OTEKIN\n\s*Reply 3\./);
    assert.doesNotMatch(ui.screen(), /spoofed/);
    await ui.type('/HELP\r');
    assert.match(ui.screen(), /Make yourself at home/);
    assert.strictEqual(requests.length, 3);
  } finally {
    await ui.close();
  }
});

test('the header title uses the default foreground and /clear reports why a request stopped', async () => {
  let signal;
  const ui = await terminalApp({services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat(_messages, options) {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), {once: true});
      });
    }
  }});
  try {
    const header = ui.emulator.buffer.active.getLine(0);
    const titleColumn = header.translateToString(true).indexOf('/ Chat');
    assert(titleColumn > 0);
    // Chalk disables color when the test runner's stdout is not a terminal.
    if (header.getCell(1).isFgPalette()) {
      assert(header.getCell(titleColumn).isFgDefault());
      assert(header.getCell(titleColumn).isDim());
    }
    await ui.type('Stop me\r');
    await waitFor(() => Boolean(signal));
    await ui.type('/clear\r');
    await waitFor(() => signal.aborted);
    await waitFor(() => ui.screen().includes("Hi, I'm Ömer"));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(ui.screen(), /Conversation cleared/);
    assert.doesNotMatch(ui.screen(), /Cancelled\./);
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

test('Tab on narrow terminals preserves unsent drafts, including while a reply is pending', async () => {
  let reply;
  const ui = await terminalApp({columns: 80, rows: 24, services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: () => new Promise(resolve => {reply = resolve;})
  }});
  try {
    await ui.type('\t');
    assert.match(ui.screen(), /Keyboard shortcuts and commands/);
    await ui.type('\u0015An unsent draft\u001b[D');
    const cursor = ui.emulator.buffer.active.cursorX;
    await ui.type('\t');
    assert.match(ui.screen(), /│ › An unsent draft/);
    assert.strictEqual(ui.emulator.buffer.active.cursorX, cursor);
    await ui.type('\u0015A question\r');
    await waitFor(() => Boolean(reply));
    await ui.type('My follow-up draft\t');
    assert.match(ui.screen(), /│ › My follow-up draft/);
    reply({message: 'The reply arrived.'});
    await waitFor(() => ui.screen().includes('The reply arrived.'));
    assert.match(ui.screen(), /│ › My follow-up draft/);
  } finally {
    await ui.close();
  }
});

test('Down preserves a new draft unless it is leaving an active prompt recall session', async () => {
  const ui = await terminalApp({services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async () => ({message: 'A remembered answer.'})
  }});
  try {
    await ui.type('A remembered question\r');
    await waitFor(() => ui.screen().includes('A remembered answer.'));
    await ui.type('My current draft\u001b[D');
    const cursor = ui.emulator.buffer.active.cursorX;
    await ui.type('\u001b[B');
    assert.match(ui.screen(), /│ › My current draft/);
    assert.strictEqual(ui.emulator.buffer.active.cursorX, cursor);
    await ui.type('\u001b[A');
    assert.match(ui.screen(), /│ › A remembered question/);
    await ui.type('\u001b[B');
    assert.match(ui.screen(), /│ › My current draft/);
    assert.strictEqual(ui.emulator.buffer.active.cursorX, cursor);
    await ui.type('\u0015A newer draft\u001b[B');
    assert.match(ui.screen(), /│ › A newer draft/);
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
