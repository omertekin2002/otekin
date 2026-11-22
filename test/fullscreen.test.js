'use strict';

const assert = require('assert');
const {PassThrough, Writable} = require('stream');
const {Terminal} = require('@xterm/headless');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createRequire} = require('module');
const {pathToFileURL} = require('url');
const client = require('../lib/chat-client');
const chatExport = require('../lib/chat-export');
const chatHistory = require('../lib/chat-history');
const {withDownGateway} = require('./down-gateway');

const LINKS = {
  website: 'https://example.com/website',
  linkedin: 'https://example.com/linkedin',
  cv: 'https://example.com/resume'
};

// How long a test waits for the terminal to show what it expects.
const WAIT_MS = 3000;
// Pauses that pace typing and resizing like a person would. Assertions never rely on them:
// they wait for the render they expect. OTEKIN_TEST_NO_PAUSES=1 sets them to 0 to prove it.
const NO_PAUSES = Boolean(process.env.OTEKIN_TEST_NO_PAUSES);
const KEY_PAUSE_MS = NO_PAUSES ? 0 : 15;
const AFTER_TYPING_MS = NO_PAUSES ? 0 : 40;
const AFTER_RESIZE_MS = NO_PAUSES ? 0 : 80;
// Ink holds a lone Esc for 20 ms in case an escape sequence follows it. Typing the next key
// sooner would turn Esc into Alt+key, so this one wait is part of the input protocol.
const INK_ESCAPE_MS = 30;
// Ink draws at most 60 frames a second here; three frames without output means the screen settled.
const SETTLED_MS = 50;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, message) {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message || 'Terminal did not update in time.');
    await sleep(15);
  }
}

// Matches any SGR sequence (color, dim, bold, inverse, reset...).
const SGR = /\u001b\[[0-9;]*m/;

// Chalk turns Ink's colors off when the test runner's stdout is not a terminal.
// Force a color level on the chalk that Ink itself loads, so its styling reaches raw output.
async function withInkColor(run) {
  const chalkPath = createRequire(require.resolve('ink')).resolve('chalk');
  const {default: chalk} = await import(pathToFileURL(chalkPath).href);
  const level = chalk.level;
  chalk.level = 1;
  try {
    return await run();
  } finally {
    chalk.level = level;
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
  let lastOutput = Date.now();
  const stdout = Object.assign(new Writable({write(chunk, _encoding, done) {
    raw += chunk.toString();
    lastOutput = Date.now();
    emulator.write(chunk.toString(), done);
  }}), {isTTY: true, columns, rows});
  const stdin = new PassThrough();
  const rawModes = [];
  Object.assign(stdin, {isTTY: true, setRawMode(value) {rawModes.push(value);}, ref() {}, unref() {}});
  const opened = [];
  const app = render(React.createElement(TerminalApp, {
    links: LINKS, version: 'test', openInBrowser: async url => opened.push(url), env: {}, ...options
  }), {
    stdout, stdin, stderr: stdout, alternateScreen: true, interactive: true,
    exitOnCtrlC: false, incrementalRendering: true, maxFps: 60
  });
  const screen = () => Array.from({length: stdout.rows}, (_,index) =>
    emulator.buffer.active.getLine(index)?.translateToString(true) || '').join('\n');
  // The emulator parses output asynchronously; until it is done, the screen can show half a frame.
  const parsed = () => stdout.writableLength === 0;
  const type = async text => {
    const keys = text.includes('\u001b[200~') ? [text]
      : text.match(/\u001b\[[0-9;:]*[A-Za-z~]|\u001b[^[]|[\u0000-\u001f\u007f]|[^\u0000-\u001f\u007f]+/gu) || [];
    for (const key of keys) {
      stdin.write(key);
      // Wait until Ink has read this key, so each key reaches the app on its own, as typed.
      const deadline = Date.now() + WAIT_MS;
      while (stdin.readableLength > 0) {
        if (Date.now() > deadline) throw new Error(`The app did not read the key ${JSON.stringify(key)}.`);
        await new Promise(resolve => setImmediate(resolve));
      }
      await sleep(key === '\u001b' ? Math.max(INK_ESCAPE_MS, KEY_PAUSE_MS) : KEY_PAUSE_MS);
    }
    await sleep(AFTER_TYPING_MS);
  };
  // Waits until check() holds on a fully drawn screen. On timeout it fails with the screen.
  const waitUntil = async (check, message) => {
    const deadline = Date.now() + WAIT_MS;
    while (!(parsed() && check())) {
      if (Date.now() > deadline) {
        throw new assert.AssertionError({
          message: `Timed out after ${WAIT_MS} ms: ${message || 'the terminal did not show what was expected'}.\nScreen:\n${screen()}`
        });
      }
      await sleep(15);
    }
  };
  // assert.match on the screen that waits for a render that matches, and returns that screen.
  // On timeout it fails with assert.match's own error, screen included.
  const expectScreen = async (pattern, message) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const text = screen();
      if (parsed() && pattern.test(text)) return text;
      if (Date.now() > deadline) {
        try {
          assert.match(text, pattern);
        } catch (error) {
          error.message = `Timed out after ${WAIT_MS} ms${message ? `: ${message}` : ''}. ${error.message}`;
          throw error;
        }
        return text;
      }
      await sleep(15);
    }
  };
  // For keys that should change nothing on screen: waits until the app has drawn nothing new for
  // a few frames, so a wrong render would show up before the test checks that nothing changed.
  const settle = () => waitUntil(() => Date.now() - lastOutput >= SETTLED_MS, 'the screen kept changing');
  await waitFor(() => /Ready when you are|Restored your last conversation/.test(screen()));
  await waitUntil(() => true, 'the first frame was not drawn');
  return {
    screen, type, waitUntil, expectScreen, settle, opened, stdout, stdin, emulator, rawModes, raw: () => raw,
    async resize(width, height) {
      emulator.resize(width, height);
      stdout.columns = width;
      stdout.rows = height;
      stdout.emit('resize');
      await sleep(AFTER_RESIZE_MS);
    },
    async close() {
      app.unmount();
      await app.waitUntilExit();
      await sleep(30);
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
  // Terminals often send pasted line breaks as a lone carriage return.
  assert.strictEqual(sanitizeInput('a\rb'), 'a\nb');
  assert.strictEqual(sanitizeInput('a\r\nb'), 'a\nb');
  assert.strictEqual(sanitizeInput('a\r\rb'), 'a\n\nb');
  assert.strictEqual(sanitizeInput('a\u001b[2J\rb\u0007'), 'a\nb');
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
    // The narrow footer, on the new last row, shows the narrow layout is drawn.
    await ui.expectScreen(/Enter send · \/ commands[^\n]*$/);
    assert.doesNotMatch(ui.screen(), /WORKSPACE/);
    assert.match(ui.screen(), /›_ otekin/);
    assert.match(ui.screen().split('\n')[17], /Enter send/);
    await ui.resize(20, 6);
    await ui.expectScreen(/Resize to at least/);
    await ui.resize(110, 30);
    await ui.expectScreen(/WORKSPACE/);
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

test('welcome, /profile, and the sidebar show the same name and tagline at every size', async () => {
  const name = 'Ömer Tekin';
  const tagline = 'Law & business student at Koç University.';
  for (const [columns, rows] of [[120, 40], [80, 24]]) {
    const ui = await terminalApp({columns, rows});
    // Below the header, the 27-column sidebar follows the app's one-column left padding.
    const body = () => ui.screen().split('\n').slice(2, -1);
    const main = () => body().map(line => line.slice(columns >= 100 ? 28 : 1).trim());
    try {
      assert(main().includes("Hi, I'm Ömer Tekin."), `welcome greeting at ${columns}×${rows}`);
      assert(main().includes(tagline), `welcome tagline at ${columns}×${rows}`);
      if (columns >= 100) {
        const sidebar = body().map(line => line.slice(1, 28).trimEnd());
        assert.strictEqual(sidebar[1], name.toUpperCase());
        const wrapped = sidebar.slice(2, sidebar.indexOf('WORKSPACE'));
        assert.deepStrictEqual(wrapped, ['Law & business student at', 'Koç University.']);
        assert(wrapped.every(line => line.length <= 25), 'the tagline stays inside the sidebar padding');
      } else {
        assert.doesNotMatch(ui.screen(), /ÖMER TEKIN|WORKSPACE/);
      }
      await ui.type('/profile\r');
      await ui.expectScreen(/\/ About Ömer/);
      await ui.waitUntil(() => main().includes(name), `/profile name at ${columns}×${rows}`);
      assert(main().includes(tagline), `/profile tagline at ${columns}×${rows}`);
    } finally {
      await ui.close();
    }
  }
});

test('command palette, navigation, and profile links work without leaving the app', async () => {
  const ui = await terminalApp();
  try {
    await ui.type('/li');
    await ui.expectScreen(/Find me on LinkedIn/);
    await ui.type('\t');
    await ui.expectScreen(/│ › \/linkedin/);
    await ui.type('\r');
    await waitFor(() => ui.opened.length === 1);
    assert.deepStrictEqual(ui.opened, [LINKS.linkedin]);
    await ui.type('/profile\r');
    await ui.expectScreen(/\/ About Ömer/);
    await ui.expectScreen(/Website {3}https:\/\/example.com/);
    await ui.type('/help\r');
    await ui.expectScreen(/Make yourself at home/);
    await ui.type('\t\u001b[B\r');
    await ui.expectScreen(/\/ About Ömer/);
    await ui.type('/nonsense\r');
    await ui.expectScreen(/Unknown command: \/nonsense/);
  } finally {
    await ui.close();
  }
});

test('chat keeps the composer live, preserves drafts and context, and scrolls long replies', async () => {
  const requests = [];
  /** @type {(reply: object) => void} */
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
    await ui.expectScreen(/│ › Next question/);
    await ui.type('\u001b[5~');
    // The scroll indicator shows the scrolled render is drawn.
    await ui.expectScreen(/↑ \d+ lines/);
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
    await ui.expectScreen(/│ › Next question/);
    await ui.type('\u001b[B');
    await ui.expectScreen(/│ › Ask anything/);
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
  /** @type {(reply: object) => void} */
  let reply;
  /** @type {(event: object) => void} */
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
    await ui.expectScreen(/↑ \d+ lines/);
    const before = viewport();
    const below = linesBelow();
    assert.match(before, /Answer line/);
    assert(below > 0);
    activity({id: 'search', tool: 'search_web', query: 'current news', status: 'running'});
    await ui.waitUntil(() => linesBelow() > below, 'the research line did not arrive below');
    assert.strictEqual(viewport(), before);
    reply({message: Array.from({length: 10}, (_,index) => `Second answer ${index + 1}`).join('\n')});
    await ui.waitUntil(() => linesBelow() > below + 10, 'the reply did not arrive below');
    assert.strictEqual(viewport(), before);
    await ui.type('\u001b[1;5F');
    await ui.expectScreen(/Second answer 10/);
    assert.doesNotMatch(ui.screen(), /↑ \d+ lines/);
  } finally {
    await ui.close();
  }
});

test('scrolled-up conversations stay in place when cancelling removes research lines', async () => {
  /** @type {(event: object) => void} */
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
    await ui.expectScreen(/First question/);
    const before = viewport();
    assert.match(before, /First question/);
    await ui.type('\u001b');
    await ui.waitUntil(() => signal.aborted && ui.screen().includes('Cancelled.'), 'the request was not cancelled');
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
    assert.match(ui.screen(), /gpt-6\.1-sol · [\w ]*\d{2}:\d{2}\n\s*Reply 1\./);
    await ui.type('//etc\r');
    await waitFor(() => ui.screen().includes('Reply 2.'));
    assert.strictEqual(requests[1][2].content, '/etc');
    assert.match(ui.screen(), /OTEKIN · [\w ]*\d{2}:\d{2}\n\s*Reply 2\./);
    await ui.type('\u001b[A');
    await ui.expectScreen(/│ › \/\/etc/);
    await ui.type('\u0015Third\r');
    await waitFor(() => ui.screen().includes('Reply 3.'));
    assert.match(ui.screen(), /OTEKIN · [\w ]*\d{2}:\d{2}\n\s*Reply 3\./);
    assert.doesNotMatch(ui.screen(), /spoofed/);
    await ui.type('/HELP\r');
    await ui.expectScreen(/Make yourself at home/);
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
    // Give a late "Cancelled." notice the chance to appear before checking that it doesn't.
    await sleep(50);
    await ui.expectScreen(/Conversation cleared/);
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
    await ui.expectScreen(/Hello[\s\S]*world/);
    assert.strictEqual(requests.length, 0);
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

test('bracketed pastes with carriage-return line breaks keep every line', async () => {
  const requests = [];
  const ui = await terminalApp({services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => {requests.push(messages); return {message: 'Received.'};}
  }});
  // True when each word is drawn on a screen row that holds none of the other words.
  const onOwnRows = words => words.every(word => ui.screen().split('\n').some(row =>
    row.includes(word) && words.every(other => other === word || !row.includes(other))));
  try {
    await ui.type('\u001b[200~Hello\r界\rworld\u001b[201~');
    await ui.waitUntil(() => onOwnRows(['Hello', '界', 'world']), 'the pasted lines were not kept apart');
    assert.strictEqual(requests.length, 0);
    await ui.type('\r');
    await waitFor(() => requests.length === 1);
    assert.strictEqual(requests[0][0].content, 'Hello\n界\nworld');
    await ui.type('\u001b[200~alpha\r\nbeta\r\ngamma\u001b[201~');
    await ui.waitUntil(() => onOwnRows(['alpha', 'beta', 'gamma']), 'the pasted lines were not kept apart');
    assert.strictEqual(requests.length, 1);
    await ui.type('\r');
    await waitFor(() => requests.length === 2);
    assert.strictEqual(requests[1][2].content, 'alpha\nbeta\ngamma');
  } finally {
    await ui.close();
  }
});

test('Tab on narrow terminals preserves unsent drafts, including while a reply is pending', async () => {
  /** @type {(reply: object) => void} */
  let reply;
  const ui = await terminalApp({columns: 80, rows: 24, services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: () => new Promise(resolve => {reply = resolve;})
  }});
  const composer = () => ui.screen().split('\n').find(line => line.includes('│ ›')) || '';
  try {
    await ui.type('\t');
    await ui.expectScreen(/Keyboard shortcuts and commands/);
    await ui.type('\u0015An unsent draft\u001b[D');
    // The caret sits on the draft's last character.
    await ui.waitUntil(() => ui.emulator.buffer.active.cursorX === composer().indexOf('An unsent draft') + 14, 'the caret did not move left');
    const cursor = ui.emulator.buffer.active.cursorX;
    await ui.type('\t');
    await ui.settle();
    assert.match(ui.screen(), /│ › An unsent draft/);
    assert.strictEqual(ui.emulator.buffer.active.cursorX, cursor);
    await ui.type('\u0015A question\r');
    await waitFor(() => Boolean(reply));
    await ui.type('My follow-up draft\t');
    await ui.expectScreen(/│ › My follow-up draft/);
    await ui.settle();
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
  const composer = () => ui.screen().split('\n').find(line => line.includes('│ ›')) || '';
  try {
    await ui.type('A remembered question\r');
    await waitFor(() => ui.screen().includes('A remembered answer.'));
    await ui.type('My current draft\u001b[D');
    // The caret sits on the draft's last character.
    await ui.waitUntil(() => ui.emulator.buffer.active.cursorX === composer().indexOf('My current draft') + 15, 'the caret did not move left');
    const cursor = ui.emulator.buffer.active.cursorX;
    await ui.type('\u001b[B');
    await ui.settle();
    assert.match(ui.screen(), /│ › My current draft/);
    assert.strictEqual(ui.emulator.buffer.active.cursorX, cursor);
    await ui.type('\u001b[A');
    await ui.expectScreen(/│ › A remembered question/);
    await ui.type('\u001b[B');
    await ui.expectScreen(/│ › My current draft/);
    await ui.waitUntil(() => ui.emulator.buffer.active.cursorX === cursor, 'Down did not restore the caret');
    await ui.type('\u0015A newer draft\u001b[B');
    await ui.expectScreen(/│ › A newer draft/);
    await ui.settle();
    assert.match(ui.screen(), /│ › A newer draft/);
  } finally {
    await ui.close();
  }
});

test('cancelling a request keeps the app usable and cannot commit a stale reply', async () => {
  let signal;
  /** @type {(error: Error) => void} */
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
    // The failed question goes back into the empty composer; the cancelled one never did.
    await ui.expectScreen(/│ › Keep this draft/);
  } finally {
    await ui.close();
  }
});

test('a reply with a megabyte of blank lines renders and Ctrl+C still exits', async () => {
  const ui = await terminalApp({services: {
    ...client, ensureChatServiceAwake: async () => {},
    // Trimming blank lines used to rescan the rest of a reply like this from every line break.
    requestChat: async () => ({message: 'Blank lines follow' + '\n\n'.repeat(512 * 1024) + 'Last line\n\n \n'})
  }});
  try {
    await ui.type('Hello\r');
    await ui.expectScreen(/Last line/);
    await ui.type('\u0003');
    await waitFor(() => ui.emulator.buffer.active.type === 'normal');
  } finally {
    await ui.close();
  }
});

function streamingServices() {
  const state = {requests: 0};
  return {state, services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat(_messages, options) {
      state.requests += 1;
      state.onDelta = options.onDelta;
      state.onActivity = options.onActivity;
      state.signal = options.signal;
      return new Promise((resolve, reject) => {
        state.resolve = resolve;
        state.reject = reject;
        options.signal.addEventListener('abort', () => reject(new Error('Cancelled')), {once: true});
      });
    }
  }};
}

test('streamed reply text appears before done and settles on the canonical answer', async () => {
  const canonical = {message: 'Canonical **answer** with a citation [1].', webSources: [{title: 'Source', url: 'https://example.com/source'}]};
  const {state, services} = streamingServices();
  const ui = await terminalApp({services});
  let finalScreen;
  try {
    await ui.type('Stream please\r');
    await waitFor(() => Boolean(state.onDelta));
    state.onActivity({id: 'search', tool: 'search_web', query: 'live answers', status: 'running'});
    state.onDelta('Provisional ');
    state.onDelta('words are ');
    await waitFor(() => ui.screen().includes('Provisional words are'));
    assert.match(ui.screen(), /WRITING · provisional/);
    assert.match(ui.screen(), /Writing · \d+s/);
    assert.match(ui.screen(), /Searching[^\n]*live answers[\s\S]*Provisional words are/);
    state.onDelta('arriving.');
    await waitFor(() => ui.screen().includes('Provisional words are arriving.'));
    state.resolve(canonical);
    await waitFor(() => ui.screen().includes('Canonical'));
    assert.doesNotMatch(ui.screen(), /Provisional|WRITING/);
    finalScreen = ui.screen();
  } finally {
    await ui.close();
  }

  const plain = await terminalApp({services: {
    ...client, ensureChatServiceAwake: async () => {},
    async requestChat(_messages, options) {
      options.onActivity({id: 'search', tool: 'search_web', query: 'live answers', status: 'running'});
      return canonical;
    }
  }});
  try {
    await plain.type('Stream please\r');
    await waitFor(() => plain.screen().includes('Canonical'));
    assert.strictEqual(finalScreen, plain.screen());
  } finally {
    await plain.close();
  }
});

test('streamed text never renders terminal escapes or inline image data', async () => {
  const {state, services} = streamingServices();
  const ui = await terminalApp({services});
  const base64 = 'QUJD'.repeat(200);
  try {
    await ui.type('Draw something\r');
    await waitFor(() => Boolean(state.onDelta));
    state.onDelta('\u001b[2J\u001b]0;pwned-title\u0007Safe \u001b[31mred\u001b[0m text ');
    state.onDelta('\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 then ');
    state.onDelta(`![chart](data:image/png;base64,${base64.slice(0, 300)}`);
    await waitFor(() => ui.screen().includes('[generating image…]'));
    state.onDelta(`${base64.slice(300)}) and done`);
    await waitFor(() => ui.screen().includes('and done'));
    assert.match(ui.screen(), /Safe red text link then \[generating image…\] and done/);
    state.onDelta(` raw data:image/jpeg;base64,${base64}`);
    await waitFor(() => ui.screen().includes('raw [generating image…]'));
    assert.doesNotMatch(ui.raw(), /pwned-title|evil\.example|QUJDQUJD/);
    assert.doesNotMatch(ui.raw(), /\u001b\[2J/);
    assert.strictEqual(ui.emulator.buffer.active.type, 'alternate');
  } finally {
    await ui.close();
  }
});

test('cancel, /clear, and request errors discard provisional text, including late deltas', async () => {
  const {state, services} = streamingServices();
  const ui = await terminalApp({services});
  try {
    await ui.type('First\r');
    await waitFor(() => Boolean(state.onDelta));
    state.onDelta('Cancelled provisional text');
    await waitFor(() => ui.screen().includes('Cancelled provisional text'));
    await ui.type('Draft kept');
    await ui.type('\u001b');
    await waitFor(() => state.signal.aborted && ui.screen().includes('Cancelled.'));
    state.onDelta(' late delta');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.doesNotMatch(ui.screen(), /provisional|late delta/);
    assert.match(ui.screen(), /│ › Draft kept/);

    const first = state.onDelta;
    state.onDelta = null;
    await ui.type('\u0015Second\r');
    await waitFor(() => Boolean(state.onDelta));
    const second = state.onDelta;
    second('Cleared provisional text');
    await waitFor(() => ui.screen().includes('Cleared provisional text'));
    first(' stale first delta');
    second(' and more');
    await waitFor(() => ui.screen().includes('Cleared provisional text and more'));
    assert.doesNotMatch(ui.screen(), /stale first delta/);
    await ui.type('/clear\r');
    await waitFor(() => ui.screen().includes("Hi, I'm Ömer"));
    second(' late delta');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.doesNotMatch(ui.screen(), /provisional|late delta/);

    state.onDelta = null;
    await ui.type('Third\r');
    await waitFor(() => Boolean(state.onDelta));
    state.onDelta('Failed provisional text');
    await waitFor(() => ui.screen().includes('Failed provisional text'));
    state.reject(Object.assign(new Error('Service unavailable'), {requestId: 'stream-error'}));
    await waitFor(() => ui.screen().includes('stream-error'));
    assert.doesNotMatch(ui.screen(), /provisional/);

    state.onDelta = null;
    await ui.expectScreen(/│ › Third/);
    await ui.type('\u0015Fourth\r');
    await waitFor(() => Boolean(state.onDelta));
    state.onDelta('Working again');
    await waitFor(() => ui.screen().includes('Working again'));
    state.resolve({message: 'Fourth answer.'});
    await waitFor(() => ui.screen().includes('Fourth answer.'));
    assert.strictEqual(state.requests, 4);
  } finally {
    await ui.close();
  }
});

// Spinner frames, or an elapsed-seconds counter such as "· 12s".
const MOTION = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|· \d+s/;
const statusRow = screen => screen.split('\n').find(line => /^ +… /.test(line));

test('reduced motion keeps the status row still and shows every status change', async () => {
  const {state, services} = streamingServices();
  const ui = await terminalApp({services, options: {reducedMotion: true}});
  try {
    await ui.type('Question\r');
    await waitFor(() => Boolean(state.onDelta));
    await ui.expectScreen(/… Thinking/);
    await ui.settle();
    const row = statusRow(ui.screen());
    assert.match(row, /^ +… Thinking$/);
    const before = ui.raw();
    await sleep(1500);
    // Nothing changed, so nothing was drawn: no spinner frame, no ticking counter.
    assert.strictEqual(ui.raw(), before);
    assert.strictEqual(statusRow(ui.screen()), row);
    state.onActivity({id: 'search', tool: 'search_web', query: 'motion laws', status: 'running'});
    await ui.expectScreen(/… Searching {2}motion laws/);
    state.onActivity({id: 'search', tool: 'search_web', query: 'motion laws', status: 'complete'});
    await ui.expectScreen(/… Thinking/);
    state.onDelta('Provisional ');
    state.onDelta('reduced text');
    await ui.expectScreen(/WRITING · provisional[^]*Provisional reduced text[^]*… Writing/);
    state.resolve({message: 'Canonical still answer.'});
    await ui.expectScreen(/Canonical still answer\./);
    const done = await ui.expectScreen(/Ready when you are/);
    assert.doesNotMatch(done, /Provisional|WRITING|^ +… /m);

    state.onDelta = null;
    await ui.type('Cancel me\r');
    await waitFor(() => Boolean(state.onDelta));
    await ui.expectScreen(/… Thinking/);
    await ui.type('\u001b');
    await ui.expectScreen(/Cancelled\. Ready for your next message\./);

    state.onDelta = null;
    await ui.type('Fail me\r');
    await waitFor(() => Boolean(state.onDelta));
    state.reject(new Error('Service unavailable'));
    await ui.expectScreen(/^ +Press Enter to send it again$/m);
    assert.doesNotMatch(ui.raw(), MOTION);
  } finally {
    await ui.close();
  }
});

test('OTEKIN_REDUCED_MOTION turns reduced motion on, and 0 or empty leaves the spinner', async () => {
  for (const [value, reduced] of /** @type {Array<[string, boolean]>} */ ([['1', true], ['0', false], ['', false]])) {
    const {state, services} = streamingServices();
    const ui = await terminalApp({services, env: {OTEKIN_REDUCED_MOTION: value}});
    try {
      await ui.type('Question\r');
      await waitFor(() => Boolean(state.onDelta));
      if (reduced) {
        await ui.expectScreen(/… Thinking/);
        await sleep(300);
        assert.doesNotMatch(ui.raw(), MOTION, value);
      } else {
        await ui.expectScreen(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking · \d+s/);
      }
      state.resolve({message: 'Answer.'});
      await ui.expectScreen(/Ready when you are/);
    } finally {
      await ui.close();
    }
  }
});

test('scrolled-up conversations stay in place while provisional text grows', async () => {
  const {state, services} = streamingServices();
  const ui = await terminalApp({services});
  const viewport = () => ui.screen().split('\n').slice(2, 25).join('\n');
  const linesBelow = () => Number((ui.screen().match(/↑ (\d+) lines/) || [])[1] || 0);
  try {
    await ui.type('First question\r');
    await waitFor(() => Boolean(state.resolve));
    state.resolve({message: Array.from({length: 50}, (_,index) => `Answer line ${index + 1}`).join('\n')});
    await waitFor(() => ui.screen().includes('Answer line 50'));
    state.onDelta = null;
    await ui.type('Second question\r');
    await waitFor(() => Boolean(state.onDelta));
    await ui.type('\u001b[5~');
    await ui.expectScreen(/↑ \d+ lines/);
    const before = viewport();
    const below = linesBelow();
    assert.match(before, /Answer line/);
    assert(below > 0);
    for (let index = 1; index <= 3; index += 1) {
      state.onDelta(`Streamed line ${index}\n`);
      await ui.waitUntil(() => linesBelow() > below + index, `streamed line ${index} did not arrive below`);
      assert.strictEqual(viewport(), before);
    }
    await ui.type('\u001b[1;5F');
    await ui.expectScreen(/Streamed line 3/);
  } finally {
    await ui.close();
  }
});

function historyDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-fullscreen-history-'));
  return {directory, file: path.join(directory, 'state', 'history.json')};
}

const checksum = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('saved history restores the conversation, prompt recall and sources, and /clear deletes it', async () => {
  const {directory, file} = historyDirectory();
  const requests = [];
  const sources = [{title: 'Source', url: 'https://example.com/source'}];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => {
      requests.push(messages);
      return requests.length === 1
        ? {message: 'Saved answer [1].', model: 'fixture-model', webSources: sources}
        : {message: `Answer ${requests.length}.`};
    }
  };
  try {
    const first = await terminalApp({services, historyFile: file});
    try {
      assert.match(first.screen(), /Ready when you are/);
      await first.type('Remember this question\r');
      await waitFor(() => first.screen().includes('Saved answer'));
      await waitFor(() => fs.existsSync(file));
    } finally {
      await first.close();
    }

    const second = await terminalApp({columns: 80, services, historyFile: file});
    try {
      assert.match(second.screen(), /Restored your last conversation · \/clear to forget it/);
      assert.match(second.screen(), /YOU\n\s*Remember this question/);
      assert.match(second.screen(), /fixture-model · [\w ]*\d{2}:\d{2}\n\s*Saved answer \[1\]\./);
      await second.type('\u001b[A');
      await second.expectScreen(/│ › Remember this question/);
      await second.type('\u0015Follow up\r');
      await waitFor(() => second.screen().includes('Answer 2.'));
      assert.deepStrictEqual(requests[1].map(message => message.content),
        ['Remember this question', 'Saved answer [1].', 'Follow up']);
      assert.deepStrictEqual(requests[1][1].webSources, sources);
      await waitFor(() => chatHistory.loadHistory(file)?.prompts.length === 2);
      await second.type('/clear\r');
      await waitFor(() => second.screen().includes("Hi, I'm Ömer"));
      assert.strictEqual(fs.existsSync(file), false);
      await second.type('\u001b[A');
      await second.settle();
      assert.match(second.screen(), /│ › Ask anything/, '/clear forgets saved prompts too');
    } finally {
      await second.close();
    }

    const third = await terminalApp({services, historyFile: file});
    try {
      assert.match(third.screen(), /Ready when you are/);
      assert.match(third.screen(), /Hi, I'm Ömer/);
      assert.doesNotMatch(third.screen(), /Remember this question|Follow up/);
    } finally {
      await third.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('full-screen chat stops saving when another chat changes or clears the history file', async () => {
  const {directory, file} = historyDirectory();
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => ({message: `Answer ${messages.length}.`, model: 'fixture-model'})
  };
  const questions = () => chatHistory.loadHistory(file)?.history.filter(message => message.role === 'user')
    .map(message => message.content);
  const conversation = content => ({history: [{role: 'user', content}, {role: 'assistant', content: 'Saved.'}],
    messages: [{role: 'user', content}, {role: 'assistant', model: 'fixture-model', content: 'Saved.'}], prompts: [content]});
  try {
    chatHistory.saveHistory(file, conversation('Saved before'));
    const ui = await terminalApp({columns: 80, services, historyFile: file});
    try {
      await ui.expectScreen(/Restored your last conversation/);
      // Another chat saves its own conversation while this one is open.
      chatHistory.saveHistory(file, conversation('Saved by another chat'));
      const before = checksum(file);
      await ui.type('Asked here\r');
      await waitFor(() => ui.screen().includes('Answer 3.'));
      // The whole notice fits the status line at 80 columns.
      await ui.expectScreen(new RegExp(chatHistory.HISTORY_CHANGED_NOTICE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
      assert.strictEqual(checksum(file), before);
      await ui.type('Asked again\r');
      await waitFor(() => ui.screen().includes('Answer 5.'));
      await ui.settle();
      assert.strictEqual(checksum(file), before, 'later replies are not saved either');
      assert.doesNotMatch(ui.screen(), /Could not save/);
      // This chat's own /clear starts it over, and it saves again.
      await ui.type('/clear\r');
      await waitFor(() => ui.screen().includes("Hi, I'm Ömer"));
      assert.strictEqual(fs.existsSync(file), false);
      await ui.type('Fresh start\r');
      await waitFor(() => ui.screen().includes('Answer 1.'));
      await waitFor(() => fs.existsSync(file));
      assert.deepStrictEqual(questions(), ['Fresh start']);
      assert.doesNotMatch(ui.screen(), /Another chat changed/);

      // Another chat's /clear deletes the file: this chat does not write the conversation back.
      chatHistory.clearHistory(file);
      await ui.type('After the other clear\r');
      await waitFor(() => ui.screen().includes('Answer 3.'));
      await ui.expectScreen(/Another chat changed saved history/);
      await ui.settle();
      assert.strictEqual(fs.existsSync(file), false);
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

// Every clickable label in the output, as "url label".
const terminalLinks = raw => [...new Set([...raw.matchAll(/\u001b\]8;;(https?:[^\u0007]+)\u0007([^\u001b]*)\u001b\]8;;\u0007/g)]
  .map(([, url, label]) => `${url} ${label}`))].sort();

test('restored replies keep their clickable sources, /save links and /retry replacement', async () => {
  const {directory, file} = historyDirectory();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  const replies = [
    {
      message: 'Cited **answer** [1][2].\n\nSources:\n- [1] [First footer](<https://example.com/first>)\n- [2] [Second footer](<https://example.com/second?q=(x)>)',
      model: 'fixture-model',
      webSources: [
        {number: 1, title: 'First source', url: 'https://example.com/first'},
        {number: 2, title: 'Second source', url: 'https://example.com/second?q=(x)'}
      ]
    },
    {message: 'Retried answer [3].', model: 'fixture-model', webSources: [{number: 3, title: 'Third source', url: 'https://example.com/third'}]}
  ];
  const requests = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => {
      requests.push(messages);
      return replies[requests.length - 1];
    }
  };
  const savedFiles = () => fs.readdirSync(saveDirectory).sort();
  // The transcript without its timestamped heading.
  const savedBody = name => fs.readFileSync(path.join(saveDirectory, name), 'utf8').replace(/^# .*\n/, '');
  const expected = [
    'https://example.com/first [1] First source',
    'https://example.com/second?q=(x) [2] Second source'
  ];
  try {
    const first = await terminalApp({services, historyFile: file, saveDirectory});
    let liveLinks;
    try {
      await first.type('Cite something\r');
      await waitFor(() => first.screen().includes('Sources: [1] First source · [2] Second source'));
      liveLinks = terminalLinks(first.raw());
      assert.deepStrictEqual(liveLinks, expected);
      await waitFor(() => chatHistory.loadHistory(file)?.messages.length === 2);
      await first.type('/save\r');
      await waitFor(() => savedFiles().length === 1);
    } finally {
      await first.close();
    }
    const live = savedBody(savedFiles()[0]);
    assert.match(live, /Sources: \[\\\[1\\\] First source\]\(https:\/\/example\.com\/first\) · \[\\\[2\\\] Second source\]\(https:\/\/example\.com\/second\?q=%28x%29\)\n$/);

    const second = await terminalApp({columns: 80, services, historyFile: file, saveDirectory});
    try {
      assert.match(second.screen(), /Restored your last conversation/);
      assert.match(second.screen(), /fixture-model · [\w ]*\d{2}:\d{2}\n\s*Cited answer \[1\]\[2\]\.\n\s*\n\s*Sources: \[1\] First source · \[2\] Second source/);
      assert.deepStrictEqual(terminalLinks(second.raw()), liveLinks);
      assert.match(second.raw(), /\u001b\[1manswer/, 'restored replies keep their styling');
      await second.type('/save\r');
      await waitFor(() => savedFiles().length === 2);
      assert.strictEqual(savedBody(savedFiles()[1]), live);

      await second.type('/retry\r');
      await waitFor(() => second.screen().includes('Retried answer [3].'));
      assert.doesNotMatch(second.screen(), /Cited answer/);
      const savedReplies = () => chatHistory.loadHistory(file)?.messages.filter(message => message.role === 'assistant');
      await waitFor(() => savedReplies()?.[0]?.answer === 'Retried answer [3].');
      assert.strictEqual(savedReplies().length, 1);
      assert.deepStrictEqual(savedReplies()[0].sources, [{number: 3, title: 'Third source', url: 'https://example.com/third'}]);
    } finally {
      await second.close();
    }

    const third = await terminalApp({columns: 80, services, historyFile: file, saveDirectory});
    try {
      assert.match(third.screen(), /Retried answer \[3\]\.\n\s*\n\s*Sources: \[3\] Third source/);
      assert.deepStrictEqual(terminalLinks(third.raw()), ['https://example.com/third [3] Third source']);
    } finally {
      await third.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

// Runs one interactive linear chat session to the end of its input and returns what it printed.
async function linearSession(lines, options) {
  const {startLinearChat} = require('../lib/linear-chat');
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', chunk => { out += chunk.toString(); });
  const chat = startLinearChat({input, output, color: false, echo: true, interactive: true, saveImages: response => response, ...options});
  for (const line of lines) {
    input.write(line + '\n');
    // Each line waits for the prompt, so commands run after the reply before them.
    await waitFor(() => out.endsWith('You: ') && out.split('You: ').length - 1 > lines.indexOf(line) + 1);
  }
  input.end();
  await chat.finished;
  return out;
}

test('linear and full-screen chat continue each other’s saved conversation', async () => {
  const {directory, file} = historyDirectory();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  const replies = [
    {message: 'Linear answer [1].', model: 'linear-model', webSources: [{number: 1, title: 'Linear source', url: 'https://example.com/linear'}]},
    {message: 'Full-screen answer [2].', model: 'screen-model', webSources: [{number: 2, title: 'Screen source', url: 'https://example.com/screen'}]},
    {message: 'Last answer.', model: 'linear-model'}
  ];
  const requests = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => {
      requests.push(messages);
      return replies[requests.length - 1];
    }
  };
  try {
    const first = await linearSession(['Asked in linear'], {services, historyFile: file, now: () => Date.UTC(2026, 10, 16, 9, 5)});
    assert.doesNotMatch(first, /Continuing/);
    assert(fs.existsSync(file));

    const screen = await terminalApp({columns: 80, services, historyFile: file, saveDirectory});
    try {
      assert.match(screen.screen(), /Restored your last conversation/);
      assert.match(screen.screen(), /YOU\n\s*Asked in linear/);
      assert.match(screen.screen(), /linear-model · [\w ]*\d{2}:05\n\s*Linear answer \[1\]\.\n\s*\n\s*Sources: \[1\] Linear source/);
      assert.deepStrictEqual(terminalLinks(screen.raw()), ['https://example.com/linear [1] Linear source']);
      await screen.type('\u001b[A');
      await screen.expectScreen(/│ › Asked in linear/);
      await screen.type('\u0015Asked in full screen\r');
      await waitFor(() => screen.screen().includes('Full-screen answer [2].'));
      assert.deepStrictEqual(requests[1].map(message => message.content.split('\n')[0]),
        ['Asked in linear', 'Linear answer [1].', 'Asked in full screen']);
      assert.deepStrictEqual(requests[1][1].webSources, replies[0].webSources);
      await waitFor(() => chatHistory.loadHistory(file)?.messages.filter(message => message.role === 'assistant').length === 2);
    } finally {
      await screen.close();
    }

    const last = await linearSession(['Asked in linear again', '/save'], {services, historyFile: file, saveDirectory});
    assert.strictEqual(last.split('Continuing your saved conversation (2 questions).').length - 1, 1);
    assert.doesNotMatch(last, /Linear answer|Full-screen answer/, 'restored replies are not printed again');
    assert.deepStrictEqual(requests[2].map(message => message.content.split('\n')[0]),
      ['Asked in linear', 'Linear answer [1].', 'Asked in full screen', 'Full-screen answer [2].', 'Asked in linear again']);
    const [saved] = fs.readdirSync(saveDirectory);
    const markdown = fs.readFileSync(path.join(saveDirectory, saved), 'utf8');
    assert.match(markdown, /## linear-model · 2026-11-16 \d{2}:05\n\nLinear answer \[1\]\.\n\nSources: \[\\\[1\\\] Linear source\]\(https:\/\/example\.com\/linear\)\n/);
    assert.match(markdown, /## screen-model · \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\nFull-screen answer \[2\]\.\n\nSources: \[\\\[2\\\] Screen source\]\(https:\/\/example\.com\/screen\)\n/);
    assert.match(markdown, /## You\n\nAsked in linear again\n\n## linear-model · .*\n\nLast answer\.\n$/);
    assert.deepStrictEqual(chatHistory.loadHistory(file).prompts, ['Asked in linear', 'Asked in full screen', 'Asked in linear again']);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('a restored reply without sources keeps its Markdown in /save, /copy, its styling, and linear /last', async () => {
  const {directory, file} = historyDirectory();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  const markdown = '# Title\n\nSome **bold** and `code` here.\n\n- item';
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async () => ({message: markdown, model: 'fixture-model'})
  };
  const {copied, clipboard} = fakeClipboard();
  const savedFiles = () => fs.readdirSync(saveDirectory).sort();
  // The reply's section of a /save, from its heading to the end.
  const replySection = name => fs.readFileSync(path.join(saveDirectory, name), 'utf8').split(/^## fixture-model/m)[1];
  // The styled reply as the screen draws it: the bold title, and the bold and code spans.
  const styled = raw => /\u001b\[1mTitle/.test(raw) && /\u001b\[1mbold/.test(raw) && /\u001b\[3\dmcode/.test(raw);
  try {
    let before;
    await withInkColor(async () => {
      const first = await terminalApp({columns: 80, services, historyFile: file, saveDirectory, clipboard});
      try {
        await first.type('Format something\r');
        await waitFor(() => first.screen().includes('Some bold and code here.'));
        assert(styled(first.raw()), 'the live reply is styled');
        await waitFor(() => chatHistory.loadHistory(file)?.messages.length === 2);
        await first.type('/save\r');
        await waitFor(() => savedFiles().length === 1);
        await first.type('/copy\r');
        await waitFor(() => copied.length === 1);
      } finally {
        await first.close();
      }
      before = replySection(savedFiles()[0]);
      assert(before.endsWith(`\n\n${markdown}\n`), before);
      assert.strictEqual(copied[0], `${markdown}\n`);

      const second = await terminalApp({columns: 80, services, historyFile: file, saveDirectory, clipboard});
      try {
        assert.match(second.screen(), /Restored your last conversation/);
        assert.match(second.screen(), /fixture-model · [\w ]*\d{2}:\d{2}\n\s*Title\n\s*\n\s*Some bold and code here\.\n\s*\n\s*- item/);
        assert(styled(second.raw()), 'the restored reply keeps its styling');
        await second.type('/save\r');
        await waitFor(() => savedFiles().length === 2);
        await second.type('/copy\r');
        await waitFor(() => copied.length === 2);
      } finally {
        await second.close();
      }
    });
    assert.strictEqual(replySection(savedFiles()[1]), before);
    assert.strictEqual(copied[1], copied[0]);

    // Linear chat restores the same file with the same Markdown.
    const linearCopied = [];
    const out = await linearSession(['/last', '/save', '/copy'], {
      services, historyFile: file, saveDirectory, copy: async text => { linearCopied.push(text); return 'pbcopy'; }
    });
    assert(out.includes(`You: /last\nfixture-model`) && out.includes(`:\n${markdown}\n\nYou: /save`), out);
    assert.deepStrictEqual(linearCopied, [`${markdown}\n`]);
    assert.strictEqual(savedFiles().length, 3);
    assert.strictEqual(replySection(savedFiles()[2]), before);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('restored replies without color keep their links, and bad saved sources stay plain text', async () => {
  const {directory, file} = historyDirectory();
  const reply = (sources, extra = {}) => ({
    role: 'assistant', model: 'fixture-model', content: 'Plain answer [1].\n\nSources: [1] Saved', answer: 'Linked **answer** [1].', sources, ...extra
  });
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({version: 1, history: [], prompts: [], messages: [
      {role: 'user', content: 'Good'},
      reply([{number: 1, title: 'Saved', url: 'https://example.com/saved'}]),
      {role: 'user', content: 'Bad'},
      reply([{number: 1, title: '\u001b]0;pwned\u0007Evil', url: 'javascript:alert(1)'}], {content: 'Unlinked answer [1].'})
    ]}));
    await withInkColor(async () => {
      const ui = await terminalApp({columns: 80, historyFile: file, env: {NO_COLOR: '1'}});
      try {
        assert.match(ui.screen(), /Linked \*\*answer\*\* \[1\]\.\n\s*\n\s*Sources: \[1\] Saved/);
        assert.match(ui.screen(), /Unlinked answer \[1\]\./);
        assert.deepStrictEqual(terminalLinks(ui.raw()), ['https://example.com/saved [1] Saved']);
        assert.doesNotMatch(ui.raw(), SGR);
        assert.doesNotMatch(ui.raw(), /pwned|javascript|Evil/);
      } finally {
        await ui.close();
      }
    });
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('replies show their answer time after the model label, after a restart, /retry and in /save', async () => {
  const {directory, file} = historyDirectory();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  let clock = new Date(2026, 9, 30, 14, 15, 30).getTime();
  const now = () => clock;
  let answers = 0;
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async () => ({message: `Answer ${++answers}.`, model: 'time-model'})
  };
  const savedReply = () => chatHistory.loadHistory(file)?.messages.find(message => message.role === 'assistant');
  try {
    const first = await terminalApp({columns: 80, services, historyFile: file, now});
    try {
      await first.type('When was this?\r');
      await waitFor(() => first.screen().includes('Answer 1.'));
      assert.match(first.screen(), /time-model · 14:15\n\s*Answer 1\./);
      assert.match(first.screen(), /YOU\n\s*When was this\?/, 'user messages have no time');
      await waitFor(() => savedReply()?.answeredAt === new Date(clock).toISOString());
    } finally {
      await first.close();
    }

    // The next day, the same reply shows its date too.
    clock = new Date(2026, 9, 31, 9, 5, 0).getTime();
    const second = await terminalApp({columns: 80, services, historyFile: file, saveDirectory, now});
    try {
      assert.match(second.screen(), /Restored your last conversation/);
      assert.match(second.screen(), /time-model · 30 Oct 14:15\n\s*Answer 1\./);
      await second.type('/save\r');
      await waitFor(() => fs.readdirSync(saveDirectory).length === 1);
      const saved = fs.readFileSync(path.join(saveDirectory, fs.readdirSync(saveDirectory)[0]), 'utf8');
      assert.match(saved, /\n## You\n\nWhen was this\?\n\n## time-model · 2026-10-30 14:15\n\nAnswer 1\.\n$/);

      await second.type('/retry\r');
      await waitFor(() => second.screen().includes('Answer 2.'));
      assert.match(second.screen(), /time-model · 09:05\n\s*Answer 2\./);
      assert.doesNotMatch(second.screen(), /30 Oct/);
      await waitFor(() => savedReply()?.answeredAt === new Date(clock).toISOString());
    } finally {
      await second.close();
    }

    const third = await terminalApp({columns: 80, services, historyFile: file, now});
    try {
      assert.match(third.screen(), /time-model · 09:05\n\s*Answer 2\./);
    } finally {
      await third.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('an open chat dates its earlier replies once the local day changes', async () => {
  let clock = new Date(2026, 9, 30, 23, 59, 59, 500).getTime();
  const ui = await terminalApp({columns: 80, now: () => clock, services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async () => ({message: 'Late answer.', model: 'night-model'})
  }});
  try {
    await ui.type('Still up?\r');
    await waitFor(() => ui.screen().includes('Late answer.'));
    assert.match(ui.screen(), /night-model · 23:59\n/);
    clock = new Date(2026, 9, 31, 0, 0, 1).getTime();
    await waitFor(() => ui.screen().includes('night-model · 30 Oct 23:59'), 'the label did not change at midnight');
  } finally {
    await ui.close();
  }
});

test('saved replies without an answer time show none, and NO_COLOR shows times as plain text', async () => {
  const {directory, file} = historyDirectory();
  const now = () => new Date(2026, 9, 31, 9, 5, 0).getTime();
  const write = messages => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({version: 1, history: [], prompts: [], messages}));
  };
  try {
    // Today's format, from before answer times were saved.
    write([
      {role: 'user', content: 'Old question'},
      {role: 'assistant', model: 'legacy-model', content: 'Legacy answer [1].\n\nSources: [1] Saved',
        answer: 'Legacy answer [1].', sources: [{number: 1, title: 'Saved', url: 'https://example.com/saved'}]},
      {role: 'assistant', model: 'bad-time-model', content: 'Bad time answer.', answeredAt: 'yesterday'}
    ]);
    const legacy = await terminalApp({columns: 80, historyFile: file, now});
    try {
      assert.match(legacy.screen(), /legacy-model\n\s*Legacy answer \[1\]\.\n\s*\n\s*Sources: \[1\] Saved/);
      assert.match(legacy.screen(), /bad-time-model\n\s*Bad time answer\./);
      assert.doesNotMatch(legacy.screen(), / · \d/);
      assert.deepStrictEqual(terminalLinks(legacy.raw()), ['https://example.com/saved [1] Saved']);
    } finally {
      await legacy.close();
    }

    write([
      {role: 'user', content: 'Question'},
      {role: 'assistant', model: 'plain-model', content: 'Answered last year.', answeredAt: new Date(2025, 9, 30, 14, 15).toISOString()},
      {role: 'assistant', model: 'plain-model', content: 'Answered today.', answeredAt: new Date(2026, 9, 31, 8, 0).toISOString()}
    ]);
    await withInkColor(async () => {
      const plain = await terminalApp({columns: 80, historyFile: file, now, env: {NO_COLOR: '1'}});
      try {
        assert.match(plain.screen(), /plain-model · 30 Oct 2025 14:15\n\s*Answered last year\./);
        assert.match(plain.screen(), /plain-model · 08:00\n\s*Answered today\./);
        assert.doesNotMatch(plain.raw(), SGR);
      } finally {
        await plain.close();
      }
      const colored = await terminalApp({columns: 80, historyFile: file, now});
      try {
        assert.match(colored.raw(), /\u001b\[2m · 08:00/, 'the time is muted');
      } finally {
        await colored.close();
      }
    });
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('--no-history and OTEKIN_NO_HISTORY neither read nor write the history file', async () => {
  const {directory, file} = historyDirectory();
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => ({message: `Unsaved answer ${messages.length}.`})
  };
  try {
    chatHistory.saveHistory(file, {
      history: [{role: 'user', content: 'Old question'}, {role: 'assistant', content: 'Old answer'}],
      messages: [{role: 'user', content: 'Old question'}, {role: 'assistant', model: 'OTEKIN', content: 'Old answer'}],
      prompts: ['Old question']
    });
    const before = checksum(file);
    for (const [options, env] of [[{noHistory: true}, {}], [{}, {OTEKIN_NO_HISTORY: '1'}]]) {
      const historyFile = chatHistory.historyFileFor(options, {OTEKIN_HISTORY_FILE: file, ...env});
      assert.strictEqual(historyFile, null);
      const ui = await terminalApp({services, historyFile});
      try {
        assert.match(ui.screen(), /Ready when you are/);
        assert.doesNotMatch(ui.screen(), /Old question/);
        await ui.type('\u001b[A');
        await ui.settle();
        assert.match(ui.screen(), /│ › Ask anything/);
        await ui.type('New question\r');
        await waitFor(() => ui.screen().includes('Unsaved answer'));
        await ui.type('/clear\r');
        await waitFor(() => ui.screen().includes("Hi, I'm Ömer"));
      } finally {
        await ui.close();
      }
      assert.strictEqual(checksum(file), before);
    }
    fs.rmSync(file);
    const ui = await terminalApp({services, historyFile: chatHistory.historyFileFor({noHistory: true}, {OTEKIN_HISTORY_FILE: file})});
    try {
      await ui.type('New question\r');
      await waitFor(() => ui.screen().includes('Unsaved answer'));
    } finally {
      await ui.close();
    }
    assert.strictEqual(fs.existsSync(file), false);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('unusable history files start an empty session and still restore the terminal', async () => {
  const {directory, file} = historyDirectory();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const valid = {version: 1, history: [], messages: [{role: 'user', content: 'Hidden'}], prompts: ['Hidden']};
  try {
    for (const text of ['{corrupt', JSON.stringify({...valid, version: 99}),
      JSON.stringify({...valid, padding: 'x'.repeat(chatHistory.MAX_FILE_BYTES)})]) {
      fs.writeFileSync(file, text);
      const ui = await terminalApp({historyFile: file});
      try {
        assert.match(ui.screen(), /Ready when you are/);
        assert.match(ui.screen(), /Hi, I'm Ömer/);
        assert.doesNotMatch(ui.screen(), /Hidden/);
        await ui.type('\u0003');
        await waitFor(() => ui.emulator.buffer.active.type === 'normal');
        assert.strictEqual(ui.rawModes[ui.rawModes.length - 1], false);
      } finally {
        await ui.close();
      }
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('restored history never renders terminal escapes from disk', async () => {
  const {directory, file} = historyDirectory();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    history: [],
    messages: [
      {role: 'user', content: 'Title\u001b]0;pwned-title\u0007 question'},
      {role: 'assistant', model: '\u001b[31mspoofed', content: 'Wiped\u001b[2J answer \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007'}
    ],
    prompts: ['\u001b[2JRecalled']
  }));
  try {
    const ui = await terminalApp({columns: 80, historyFile: file});
    try {
      assert.match(ui.screen(), /Title question/);
      assert.match(ui.screen(), /OTEKIN\n\s*Wiped answer link/);
      await ui.type('\u001b[A');
      await ui.expectScreen(/│ › Recalled/);
      assert.doesNotMatch(ui.raw(), /pwned-title|evil\.example|spoofed/);
      assert.doesNotMatch(ui.raw(), /\u001b\[2J/);
      assert.strictEqual(ui.emulator.buffer.active.type, 'alternate');
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('a failed save shows a status notice and the chat keeps working', async () => {
  const saves = [];
  const historyStore = {
    ...chatHistory,
    loadHistory: () => null,
    saveHistory(file, state) {
      saves.push(state);
      throw Object.assign(new Error('denied /secret/path'), {code: 'EACCES'});
    }
  };
  const ui = await terminalApp({historyFile: '/unused/history.json', historyStore, services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => ({message: `Answer ${messages.length}.`})
  }});
  try {
    await ui.type('First\r');
    await waitFor(() => ui.screen().includes('Could not save chat history (EACCES). The chat still works.'));
    assert.doesNotMatch(ui.screen(), /secret/);
    await ui.type('Second\r');
    await waitFor(() => ui.screen().includes('Answer 3.'));
    assert.strictEqual(saves.length, 2);
    assert.deepStrictEqual(saves[1].prompts, ['First', 'Second']);
    assert.strictEqual(saves[1].history.length, 4);
  } finally {
    await ui.close();
  }
});

test('/retry sends a failed or cancelled prompt again with the same request messages', async () => {
  const requests = [];
  const replies = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat(messages, options) {
      requests.push(messages);
      if (requests.length === 1) return Promise.reject(new Error('Gateway timed out.'));
      if (requests.length === 2) {
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return new Promise(resolve => replies.push(resolve));
    }
  };
  const ui = await terminalApp({services});
  try {
    await ui.type('Flaky question\r');
    await waitFor(() => ui.screen().includes('Gateway timed out.'));
    // The failed question is back in the composer; /retry still works once it is cleared.
    await ui.expectScreen(/│ › Flaky question/);
    await ui.type('\u0015/retry\r');
    await waitFor(() => requests.length === 2);
    assert.deepStrictEqual(requests[1], requests[0]);
    await ui.type('/retry\r');
    await waitFor(() => ui.screen().includes('A reply is on the way. Esc cancels it, then /retry sends it again.'));
    assert.strictEqual(requests.length, 2, 'no second request while a reply is in progress');
    await ui.type('\u001b');
    await waitFor(() => ui.screen().includes('Cancelled. Ready for your next message.'));
    await ui.type('/retry\r');
    await waitFor(() => replies.length === 1);
    assert.deepStrictEqual(requests[2], requests[0]);
    replies[0]({message: 'Finally answered.', model: 'retry-model'});
    await waitFor(() => ui.screen().includes('Finally answered.'));
    assert.match(ui.screen(), /retry-model · [\w ]*\d{2}:\d{2}\n\s*Finally answered\./);
    assert.deepStrictEqual(requests[0].map(message => message.content), ['Flaky question']);
  } finally {
    await ui.close();
  }
});

test('/retry after a reply replaces that turn in the request, transcript and saved history', async () => {
  const {directory, file} = historyDirectory();
  const requests = [];
  const firstSource = {title: 'First', url: 'https://example.com/first'};
  /** @type {(value?: unknown) => void} */
  let release;
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    async requestChat(messages) {
      requests.push(messages);
      if (requests.length === 3) await new Promise(resolve => {release = resolve;});
      const reply = requests.length - 1;
      return {
        message: ['First answer [1].', 'Old answer [2].', 'New answer [2].'][reply],
        webSources: [[firstSource], [firstSource, {title: 'Second', url: 'https://example.com/second'}]][Math.min(reply, 1)]
      };
    }
  };
  try {
    const ui = await terminalApp({services, historyFile: file});
    try {
      await ui.type('First question\r');
      await waitFor(() => ui.screen().includes('First answer [1].'));
      await ui.type('Second question\r');
      await waitFor(() => ui.screen().includes('Old answer [2].'));
      await ui.type('/retry\r');
      await waitFor(() => requests.length === 3 && release);
      assert.deepStrictEqual(requests[2], requests[1]);
      assert.deepStrictEqual(requests[2].map(message => message.content), ['First question', 'First answer [1].', 'Second question']);
      assert.deepStrictEqual(requests[2][1].webSources, [firstSource]);
      assert.match(ui.screen(), /Old answer \[2\]\./, 'the answered turn stays until its replacement arrives');
      release();
      await waitFor(() => ui.screen().includes('New answer [2].'));
      assert.doesNotMatch(ui.screen(), /Old answer/);
      assert.strictEqual(ui.screen().match(/Second question/g).length, 1);
      await waitFor(() => chatHistory.loadHistory(file)?.history[3]?.content === 'New answer [2].');
      const saved = chatHistory.loadHistory(file);
      assert.deepStrictEqual(saved.history.map(message => message.content),
        ['First question', 'First answer [1].', 'Second question', 'New answer [2].']);
      assert.deepStrictEqual(saved.messages.map(message => message.content),
        ['First question', 'First answer [1].\n\nSources: [1] First', 'Second question', 'New answer [2].\n\nSources: [1] First · [2] Second']);
      assert.deepStrictEqual(saved.prompts, ['First question', 'Second question']);
    } finally {
      await ui.close();
    }

    // A restored conversation can retry its last turn too.
    const restored = await terminalApp({services: {...services, requestChat: async messages => {
      requests.push(messages);
      return {message: 'Restored retry.'};
    }}, historyFile: file});
    try {
      await restored.type('/retry\r');
      await waitFor(() => restored.screen().includes('Restored retry.'));
      assert.deepStrictEqual(requests[3], requests[1], 'the earlier turn keeps its source catalog after a restart');
      assert.doesNotMatch(restored.screen(), /New answer/);
    } finally {
      await restored.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

const requestContents = request => request.map(message => message.content);

test('a failed replacing /retry keeps the previous answer, its saved history and its context', async () => {
  const {directory, file} = historyDirectory();
  const requests = [];
  // Each request's outcome in order: two answers, a failed /retry, a second /retry, then a follow-up.
  const outcomes = [
    {message: 'First answer.'},
    {message: 'Second answer.'},
    new client.ChatApiError('Chat service request timed out.', {code: 'request_timeout', requestId: 'retry-failure'}),
    {message: 'Second answer, retried.'},
    {message: 'Follow-up answer.'}
  ];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    async requestChat(messages) {
      const outcome = outcomes[requests.push(messages) - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
  };
  try {
    const ui = await terminalApp({services, historyFile: file});
    try {
      await ui.type('First question\r');
      await waitFor(() => ui.screen().includes('First answer.'));
      await ui.type('Second question\r');
      await waitFor(() => ui.screen().includes('Second answer.'));
      await waitFor(() => chatHistory.loadHistory(file)?.history[3]?.content === 'Second answer.');
      const before = checksum(file);

      await ui.type('/retry\r');
      await ui.expectScreen(/Chat service request timed out\. \(Request ID: retry-failure\)/);
      assert.deepStrictEqual(requests[2], requests[1], 'the retry resends the second turn');
      assert.match(ui.screen(), /CHAT ERROR/);
      assert.match(ui.screen(), /Second answer\./, 'the answered turn stays after a failed retry');
      assert.strictEqual(ui.screen().match(/Second question/g).length, 1);
      await ui.settle();
      // Nothing is put back in the composer: the answered turn is still on screen, and /retry is the way back.
      assert.match(ui.screen().replace(/\s+/g, ' '), /may have received your question\. Type \/retry to send it again\./);
      assert.match(ui.screen(), /│ › Ask anything/);
      assert.strictEqual(checksum(file), before, 'a failed retry leaves the saved history byte for byte');

      // The answered turn is still the one /retry replaces.
      await ui.type('/retry\r');
      await waitFor(() => ui.screen().includes('Second answer, retried.'));
      assert.deepStrictEqual(requests[3], requests[1], 'a retry after the failure resends the original second turn');
      assert.doesNotMatch(ui.screen(), /Second answer\./);
      assert.strictEqual(ui.screen().match(/Second question/g).length, 1);
      await waitFor(() => chatHistory.loadHistory(file)?.history[3]?.content === 'Second answer, retried.');
      assert.deepStrictEqual(requestContents(chatHistory.loadHistory(file).history),
        ['First question', 'First answer.', 'Second question', 'Second answer, retried.']);

      await ui.type('Follow-up question\r');
      await waitFor(() => ui.screen().includes('Follow-up answer.'));
      assert.deepStrictEqual(requestContents(requests[4]),
        ['First question', 'First answer.', 'Second question', 'Second answer, retried.', 'Follow-up question']);
      assert.strictEqual(requests.length, 5);
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('a cancelled replacing /retry keeps the previous answer and never commits provisional or late text', async () => {
  const {directory, file} = historyDirectory();
  const requests = [];
  /** @type {{resolve: (reply: object) => void, onDelta: (text: string) => void, signal: AbortSignal}} */
  let retry;
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat(messages, options) {
      requests.push(messages);
      if (requests.length !== 3) return Promise.resolve({message: ['First answer.', 'Second answer.', '', 'Follow-up answer.'][requests.length - 1]});
      // A reply that finishes just after it was cancelled: it ignores the abort and resolves late.
      return new Promise(resolve => {retry = {resolve, onDelta: options.onDelta, signal: options.signal};});
    }
  };
  try {
    const ui = await terminalApp({services, historyFile: file});
    try {
      await ui.type('First question\r');
      await waitFor(() => ui.screen().includes('First answer.'));
      await ui.type('Second question\r');
      await waitFor(() => ui.screen().includes('Second answer.'));
      await waitFor(() => chatHistory.loadHistory(file)?.history[3]?.content === 'Second answer.');
      const before = checksum(file);

      await ui.type('/retry\r');
      await waitFor(() => Boolean(retry));
      assert.deepStrictEqual(requests[2], requests[1], 'the retry resends the second turn');
      retry.onDelta('Provisional retry text');
      await ui.expectScreen(/Provisional retry text/);
      assert.match(ui.screen(), /Second answer\./, 'the answered turn stays while its replacement streams');
      await ui.type('\u001b');
      await waitFor(() => retry.signal.aborted);
      retry.onDelta(' late delta');
      retry.resolve({message: 'Late retry answer.'});
      await ui.expectScreen(/Cancelled\. Ready for your next message\./);
      await ui.settle();
      assert.doesNotMatch(ui.screen(), /Provisional retry text|late delta|Late retry answer/);
      assert.match(ui.screen(), /Second answer\./);
      assert.strictEqual(ui.screen().match(/Second question/g).length, 1);
      assert.strictEqual(checksum(file), before, 'a cancelled retry leaves the saved history byte for byte');

      await ui.type('Follow-up question\r');
      await waitFor(() => ui.screen().includes('Follow-up answer.'));
      assert.deepStrictEqual(requestContents(requests[3]),
        ['First question', 'First answer.', 'Second question', 'Second answer.', 'Follow-up question']);
      await waitFor(() => chatHistory.loadHistory(file)?.history[5]?.content === 'Follow-up answer.');
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Provisional retry text|late delta|Late retry answer/);
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('a long conversation stays bounded in the transcript, saved history and requests, and scrolls end to end', async () => {
  const {directory, file} = historyDirectory();
  const turns = 60;
  const label = turn => String(turn).padStart(3, '0');
  const requests = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => ({message: `Answer ${label(requests.push(messages))}.`})
  };
  // Every transcript entry the conversation produced, oldest first.
  const entries = Array.from({length: turns}, (_,index) => [`Question ${label(index + 1)}`, `Answer ${label(index + 1)}.`]).flat();
  // The 16th question is the first whose request leaves out a turn, so one notice says so before it.
  const shown = entries.toSpliced(30, 0, client.TRIMMED_CONTEXT_NOTICE);
  try {
    const ui = await terminalApp({services, historyFile: file});
    try {
      for (let turn = 1; turn <= turns; turn += 1) {
        await ui.type(`Question ${label(turn)}\r`);
        await waitFor(() => ui.screen().includes(`Answer ${label(turn)}.`), `turn ${turn} was not answered in time`);
      }
      assert.strictEqual(requests.length, turns);

      await waitFor(() => chatHistory.loadHistory(file)?.messages.at(-1)?.content === entries.at(-1));
      const saved = chatHistory.loadHistory(file);
      assert.strictEqual(saved.messages.length, chatHistory.MAX_MESSAGES);
      assert.deepStrictEqual(requestContents(saved.messages), shown.slice(-chatHistory.MAX_MESSAGES));
      assert(requests.every(request => !requestContents(request).includes(client.TRIMMED_CONTEXT_NOTICE)));

      const last = requests.at(-1);
      assert(last.length > 2 && last.length <= client.MAX_MESSAGES, `the final request sent ${last.length} messages`);
      assert.deepStrictEqual(requestContents(last), entries.slice(0, -1).slice(-last.length),
        'the final request sends the newest turns, ending with the newest question');

      // The oldest retained entry is the first answer after the 100-entry bound: the notice took one entry.
      const oldest = shown.at(-chatHistory.MAX_MESSAGES);
      assert.strictEqual(oldest, `Answer ${label(turns - chatHistory.MAX_MESSAGES / 2 + 1)}.`);
      await ui.type('\u001b[1;5H');
      await ui.expectScreen(new RegExp(oldest.replace('.', '\\.')));
      assert.doesNotMatch(ui.screen(), new RegExp(`${shown.at(-chatHistory.MAX_MESSAGES - 1)}\\b`));
      assert.doesNotMatch(ui.screen(), /Question 0(?:0\d|10)\b|Answer 060\./);
      await ui.type('\u001b[1;5F');
      await ui.expectScreen(/Answer 060\./);
      assert.match(ui.screen(), /│ › Ask anything/);
      assert.doesNotMatch(ui.screen(), new RegExp(oldest));
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('/retry with nothing to retry, including after /clear, sends nothing', async () => {
  const requests = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => {
      requests.push(messages);
      return {message: 'Answer.'};
    }
  };
  const ui = await terminalApp({services});
  try {
    await ui.type('/retry\r');
    await waitFor(() => ui.screen().includes('Nothing to retry yet. Send a message first.'));
    await ui.type('Question\r');
    await waitFor(() => ui.screen().includes('Answer.'));
    await ui.type('/clear\r');
    await waitFor(() => ui.screen().includes("Hi, I'm Ömer"));
    await ui.type('/retry\r');
    await waitFor(() => ui.screen().includes('Nothing to retry yet. Send a message first.'));
    assert.strictEqual(requests.length, 1);
  } finally {
    await ui.close();
  }
});

test('/save writes the conversation to a new Markdown file without terminal escapes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-fullscreen-save-'));
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async () => ({
      message: 'A **sourced** answer [1].\n\nSources:\n1. [Example](https://example.com/source)',
      model: 'save-model',
      webSources: [{title: 'Example source', url: 'https://example.com/source'}]
    })
  };
  const saved = () => fs.readdirSync(directory).filter(name => /^otekin-chat-\d{8}-\d{6}(?:-\d+)?\.md$/.test(name)).sort();
  // A pinned clock for the reply time and the file's heading, so the two saves below match byte
  // for byte even when the real clock crosses into a new minute between them.
  const clock = new Date(2026, 9, 30, 14, 15, 59).getTime();
  const transcriptStore = {...chatExport, saveTranscript: (target, messages, options) =>
    chatExport.saveTranscript(target, messages, {...options, date: new Date(clock)})};
  try {
    const ui = await terminalApp({services, saveDirectory: directory, now: () => clock, transcriptStore});
    try {
      await ui.type('/save\r');
      await waitFor(() => ui.screen().includes('Nothing to save yet. Send a message first.'));
      assert.deepStrictEqual(fs.readdirSync(directory), []);
      await ui.type('Find a source\r');
      await waitFor(() => ui.screen().includes('Sources: [1] Example source'));
      await ui.type('/website\r');
      await ui.type('/save\r');
      await waitFor(() => ui.screen().includes('Saved the conversation to'));
      assert.strictEqual(saved().length, 1);
      assert(ui.screen().replace(/\s+/g, '').includes(path.join(directory, saved()[0]).replace(/\s+/g, '')));
      const text = fs.readFileSync(path.join(directory, saved()[0]), 'utf8');
      assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
      assert.match(text, /^# otekin chat · 2026-10-30 14:15\n\n## You\n\nFind a source\n\n## save-model · 2026-10-30 14:15\n\n/);
      assert.match(text, /A \*\*sourced\*\* answer \[1\]\.\n\nSources: \[\\\[1\\\] Example source\]\(https:\/\/example\.com\/source\)\n$/);
      assert.doesNotMatch(text, /website:/, 'notices are left out');
      await ui.type('/save\r');
      await waitFor(() => saved().length === 2);
      assert.deepStrictEqual(saved().map(name => fs.readFileSync(path.join(directory, name), 'utf8')), [text, text]);
    } finally {
      await ui.close();
    }

    const failing = await terminalApp({services, saveDirectory: path.join(directory, 'missing', 'dir')});
    try {
      await failing.type('Question\r');
      await waitFor(() => failing.screen().includes('A sourced answer'));
      await failing.type('/save\r');
      await waitFor(() => failing.screen().includes('Could not save the conversation (ENOENT). The chat still works.'));
      assert.doesNotMatch(failing.screen(), /missing/);
      assert.strictEqual(failing.emulator.buffer.active.type, 'alternate');
      await failing.type('Again\r');
      await waitFor(() => failing.screen().match(/A sourced answer/g)?.length === 2);
    } finally {
      await failing.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('/retry, /save, /copy and /sources appear in /help and the command picker', async () => {
  const ui = await terminalApp({rows: 40});
  try {
    await ui.type('/help\r');
    await ui.expectScreen(/Make yourself at home/);
    await ui.expectScreen(/\/retry\s+Send your last message again/);
    await ui.expectScreen(/\/save\s+Save the conversation as Markdown/);
    await ui.expectScreen(/\/copy\s+Copy the latest reply and its sources/);
    await ui.expectScreen(/\/sources\s+Show the full titles and links of cited sources/);
    await ui.type('/re');
    await ui.expectScreen(/› \/retry\s+Send your last message again/);
    await ui.type('\u0015/sa');
    await ui.expectScreen(/› \/save\s+Save the conversation as Markdown/);
    await ui.type('\u0015/co');
    await ui.expectScreen(/› \/copy\s+Copy the latest reply and its sources/);
  } finally {
    await ui.close();
  }
});

test('NO_COLOR keeps the full-screen workspace free of SGR codes and focus still visible', async () => {
  await withInkColor(async () => {
    const {state, services} = streamingServices();
    const ui = await terminalApp({services, env: {NO_COLOR: '1'}});
    const lines = () => ui.screen().split('\n');
    try {
      assert.match(ui.screen(), /Hi, I'm Ömer Tekin\./);
      assert.match(ui.screen(), /› Chat/);
      assert(lines().some(line => line.includes('│ › Ask anything')), 'focused composer shows its › marker');
      assert.match(ui.screen(), /╭/);
      assert.doesNotMatch(ui.raw(), SGR, 'welcome screen');

      await ui.type('/');
      await ui.expectScreen(/› \/help\s+Keyboard shortcuts/);
      assert.match(ui.screen(), / {2}\/profile\s+Meet Ömer/);
      await ui.type('\u001b[B');
      await ui.expectScreen(/› \/profile\s+Meet Ömer/);
      assert.match(ui.screen(), / {2}\/help\s+Keyboard shortcuts/);
      assert.doesNotMatch(ui.raw(), SGR, 'command palette');
      await ui.type('\u0015\u001b');
      await ui.waitUntil(() => !/\/help\s+Keyboard shortcuts/.test(ui.screen()) && lines().some(line => line.includes('│ › Ask anything')),
        'the command palette did not close');

      await ui.type('\t\u001b[B');
      await ui.expectScreen(/› About Ömer/);
      assert.doesNotMatch(ui.screen(), /› Chat/);
      assert(!lines().some(line => line.includes('│ ›')), 'unfocused composer hides its › marker');
      assert.match(ui.screen(), /┌/);
      assert.doesNotMatch(ui.screen(), /╭/);
      assert.doesNotMatch(ui.raw(), SGR, 'navigation focus');
      await ui.type('\t');
      await ui.waitUntil(() => lines().some(line => line.includes('│ › Ask anything')), 'composer focus returns');

      await ui.type('Stream please\r');
      await waitFor(() => Boolean(state.onDelta));
      state.onActivity({id: 'search', tool: 'search_web', query: 'live answers', status: 'running'});
      state.onDelta('Provisional words');
      await waitFor(() => ui.screen().includes('Provisional words'));
      assert.match(ui.screen(), /WRITING · provisional/);
      assert.doesNotMatch(ui.raw(), SGR, 'streaming reply');
      state.resolve({message: 'Canonical **answer** [1].', webSources: [{title: 'Source', url: 'https://example.com/source'}]});
      await waitFor(() => ui.screen().includes('Canonical'));
      assert.doesNotMatch(ui.raw(), SGR, 'finished reply');

      await ui.resize(20, 6);
      await ui.expectScreen(/Resize to at least/);
      assert.doesNotMatch(ui.raw(), SGR, 'small terminal');
    } finally {
      await ui.close();
    }
  });
});

test('without NO_COLOR the full-screen workspace keeps its colors', async () => {
  await withInkColor(async () => {
    const ui = await terminalApp();
    try {
      const header = ui.emulator.buffer.active.getLine(0);
      assert(header.getCell(1).isFgPalette() && header.getCell(1).isBold(), 'cyan bold brand');
      assert.match(ui.raw(), /\u001b\[36m/);
      assert.match(ui.raw(), /\u001b\[2m/);
      assert.match(ui.screen(), /╭/);
      assert(ui.screen().split('\n').some(line => line.includes('│ › Ask anything')));
      await ui.type('\t');
      // The focused navigation item is drawn inverse; the composer keeps its round border and marker.
      const row = () => ui.screen().split('\n').findIndex(line => line.includes('› Chat'));
      await ui.waitUntil(() => row() >= 0 && ui.emulator.buffer.active.getLine(row()).getCell(1).isInverse(),
        'the focused navigation item is not drawn inverse');
      assert.match(ui.screen(), /╭/);
      assert(ui.screen().split('\n').some(line => line.includes('│ › Ask anything')));
    } finally {
      await ui.close();
    }
  });
});

// A cited reply as the gateway sends it: a numbered source footer and the matching webSources.
function citedReply(answer, sources, model = 'fixture-model') {
  const footer = sources.map(({number, title, url}) => `- [${number}] [${title.replace(/[[\]]/g, '')}](<${url || 'https://example.com/footer'}>)`);
  return {message: `${answer}\n\nSources:\n${footer.join('\n')}`, model, webSources: sources};
}

const LONG_TITLE = 'A remarkably long source title that keeps going well past the forty-eight characters the source row shows';
const LONG_URL = `https://example.com/articles/${'deep-path-segment/'.repeat(6)}final-page?query=value&another=parameter`;

test('/sources lists cited replies in full and Esc restores the draft and chat scroll', async () => {
  const replies = [
    citedReply('First cited [1][2].', [
      {number: 1, title: LONG_TITLE, url: LONG_URL},
      {number: 2, title: 'Second source', url: 'https://example.com/second'}
    ]),
    citedReply(Array.from({length: 50}, (_,index) => `Answer line ${index + 1}`).join('\n') + ' [3]', [
      {number: 3, title: 'Third source', url: 'https://example.com/third'}
    ])
  ];
  const requests = [];
  const ui = await terminalApp({columns: 80, services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => replies[requests.push(messages) - 1]
  }});
  const viewport = () => ui.screen().split('\n').slice(2, 25).join('\n');
  const flat = () => ui.screen().replace(/\s+/g, '');
  const composer = () => ui.screen().split('\n').find(line => line.includes('│ ›')) || '';
  try {
    await ui.type('First question\r');
    await waitFor(() => ui.screen().includes('First cited'));
    assert.match(ui.screen(), /Sources: \[1\] A remarkably long source title that keeps going…/);
    await ui.type('Second question\r');
    await waitFor(() => ui.screen().includes('Answer line 50'));
    await ui.type('\u001b[5~');
    const scrolled = (await ui.expectScreen(/↑ \d+ lines/)).match(/↑ \d+ lines/)[0];
    const before = viewport();
    assert.doesNotMatch(before, /Answer line 50/);

    await ui.type('/so');
    await ui.expectScreen(/› \/sources\s+Show the full titles and links of cited sources/);
    await ui.type('\r');
    await waitFor(() => ui.screen().includes('Sources · reply 2 of 2'));
    assert.match(ui.screen(), /\/ Sources/);
    assert.match(ui.screen(), /Sources · reply 2 of 2 · fixture-model · \d{2}:\d{2}/);
    assert.match(ui.screen(), /› \[3\] Third source\n\s*https:\/\/example\.com\/third/);
    assert.doesNotMatch(ui.screen(), /\[1\]/);
    assert.match(ui.screen(), /Esc back to chat/);

    await ui.type('\u001b[D');
    await ui.expectScreen(/Sources · reply 1 of 2 · fixture-model/);
    // The whole title and link, wrapped to the terminal and never shortened.
    assert(flat().includes(`[1]${LONG_TITLE.replace(/\s+/g, '')}${LONG_URL}`), ui.screen());
    assert.doesNotMatch(viewport(), /…/);
    assert.match(ui.screen(), /› \[1\] A remarkably/);
    assert.match(ui.screen(), / {2}\[2\] Second source\n\s*https:\/\/example\.com\/second/);
    await ui.type('\u001b[B');
    await ui.expectScreen(/› \[2\] Second source/);
    assert.match(ui.screen(), / {2}\[1\] A remarkably/);
    await ui.type('\u001b[B\u001b[D');
    await ui.settle();
    assert.match(ui.screen(), /Sources · reply 1 of 2/, 'the first reply stays put');
    assert.match(ui.screen(), /› \[2\] Second source/, 'the selection stays put at either end');
    await ui.type('\u001b[C');
    await ui.expectScreen(/Sources · reply 2 of 2/);
    await ui.type('\u001b[C');
    await ui.settle();
    assert.match(ui.screen(), /Sources · reply 2 of 2/);

    // Typing, editing keys and paste never reach the draft while the inspector is open.
    await ui.type('typed text\u0015\u007f\u0017');
    await ui.type('\u001b[200~pasted\u001b[201~');
    await ui.settle();
    assert.doesNotMatch(ui.screen(), /typed text|pasted/);
    await ui.type('\u001b');
    await ui.waitUntil(() => !ui.screen().includes('Sources · reply'), 'Esc did not close the sources');
    assert.match(ui.screen(), /\/ Chat/);
    assert.strictEqual(viewport(), before);
    assert.match(ui.screen(), new RegExp(scrolled));
    assert.match(composer(), /│ › Ask anything/);
    assert.doesNotMatch(ui.screen(), /typed text|pasted/);
    assert.strictEqual(requests.length, 2);

    await ui.type('abc\u001b[D');
    await ui.waitUntil(() => /│ › abc/.test(composer()) && ui.emulator.buffer.active.cursorX === composer().indexOf('abc') + 2,
      'the caret did not move left in the draft');
    const row = ui.screen().split('\n').indexOf(composer());
    assert.strictEqual(ui.emulator.buffer.active.cursorY, row);
    assert.strictEqual(ui.emulator.buffer.active.cursorX, composer().indexOf('abc') + 2);
  } finally {
    await ui.close();
  }
});

test('/sources keeps the chat in place when a reply arrives while it is open', async () => {
  const {state, services} = streamingServices();
  const ui = await terminalApp({services});
  const viewport = () => ui.screen().split('\n').slice(2, 25).join('\n');
  try {
    await ui.type('First question\r');
    await waitFor(() => Boolean(state.resolve));
    state.resolve(citedReply(Array.from({length: 50}, (_,index) => `Answer line ${index + 1}`).join('\n') + ' [1]', [
      {number: 1, title: 'First source', url: 'https://example.com/first'}
    ]));
    await waitFor(() => ui.screen().includes('Answer line 50'));
    state.resolve = null;
    await ui.type('Second question\r');
    await waitFor(() => Boolean(state.resolve));
    await ui.type('\u001b[5~');
    await ui.expectScreen(/↑ \d+ lines/);
    const before = viewport();
    await ui.type('/sources\r');
    await waitFor(() => ui.screen().includes('Sources · reply 1 of 1'));
    state.resolve(citedReply(Array.from({length: 10}, (_,index) => `Second answer ${index + 1}`).join('\n') + ' [2]', [
      {number: 2, title: 'Second source', url: 'https://example.com/second'}
    ]));
    await waitFor(() => ui.screen().includes('Sources · reply 1 of 2'));
    assert.match(ui.screen(), /› \[1\] First source/);
    await ui.type('\u001b');
    await ui.waitUntil(() => !ui.screen().includes('Sources · reply'), 'Esc did not close the sources');
    assert.strictEqual(viewport(), before);
    await ui.type('\u001b[1;5F');
    await ui.expectScreen(/Second answer 10/);

    // At the bottom of the chat, it returns to the bottom.
    await ui.type('/sources\r');
    await waitFor(() => ui.screen().includes('Sources · reply 2 of 2'));
    await ui.type('\u001b');
    await ui.waitUntil(() => !ui.screen().includes('Sources · reply'), 'Esc did not close the sources');
    assert.match(ui.screen(), /Second answer 10/);
    assert.doesNotMatch(ui.screen(), /↑ \d+ lines/);
  } finally {
    await ui.close();
  }
});

test('/sources opens the selected link, or shows it with --no-open, and never shows escapes', async () => {
  const sources = [
    {number: 1, title: 'Escaped \u001b]8;;https://evil.test\u0007Title\u001b]8;;\u0007 \u001b[31mRed', url: 'https://example.com/one'},
    {number: 2, title: 'Unlinked source', url: 'javascript:alert(1)'},
    ...Array.from({length: 10}, (_,index) => ({number: index + 3, title: `Source ${index + 3}`, url: `https://example.com/${index + 3}`}))
  ];
  const services = {...client, ensureChatServiceAwake: async () => {}, requestChat: async () => ({message: 'Many sources [1].', webSources: sources})};
  const opened = [];
  let fail = false;
  const ui = await terminalApp({columns: 80, services, openInBrowser: async url => {
    if (fail) throw new Error('no browser');
    opened.push(url);
  }});
  try {
    await ui.type('Cite a lot\r');
    await waitFor(() => ui.screen().includes('Many sources [1].'));
    const raw = ui.raw().length;
    await ui.type('/sources\r');
    await waitFor(() => ui.screen().includes('Sources · reply 1 of 1'));
    assert.match(ui.screen(), /› \[1\] Escaped/);
    assert.doesNotMatch(ui.raw().slice(raw), /\u001b\]8;;https:\/\/evil|\u001b\[31m/);
    assert.match(ui.screen(), /\[2\] Unlinked source\n\s*\(no link\)/);
    assert.doesNotMatch(ui.screen(), /\[12\]/);

    await ui.type('\r');
    await waitFor(() => opened.length === 1);
    assert.deepStrictEqual(opened, ['https://example.com/one']);
    await waitFor(() => ui.screen().includes('Opened [1] in your browser'));
    await ui.type('\u001b[B\r');
    await waitFor(() => ui.screen().includes('[2] has no link.'));
    assert.strictEqual(opened.length, 1);

    // ↓ keeps the selection in view; Page Up and Down scroll the list.
    for (let index = 0; index < 10; index += 1) await ui.type('\u001b[B');
    await ui.expectScreen(/› \[12\] Source 12/);
    assert.doesNotMatch(ui.screen(), /Sources · reply/);
    await ui.type('\u001b[5~');
    await ui.expectScreen(/Sources · reply 1 of 1/);
    assert.doesNotMatch(ui.screen(), /\[12\]/);
    await ui.type('\u001b[6~');
    await ui.expectScreen(/\[12\] Source 12/);

    fail = true;
    await ui.type('\r');
    await waitFor(() => ui.screen().includes('Could not open a browser. The link is shown above.'));
    assert.match(ui.screen(), /› \[12\] Source 12/, 'the inspector stays open');
    assert.strictEqual(opened.length, 1);
  } finally {
    await ui.close();
  }

  const quiet = await terminalApp({services, options: {noOpen: true}});
  try {
    await quiet.type('Cite a lot\r');
    await waitFor(() => quiet.screen().includes('Many sources [1].'));
    await quiet.type('/sources\r');
    await waitFor(() => quiet.screen().includes('Sources · reply 1 of 1'));
    await quiet.type('\r');
    await waitFor(() => quiet.screen().includes('[1] https://example.com/one'));
    await quiet.type('\u001b[B\r');
    await waitFor(() => quiet.screen().includes('[2] has no link.'));
    assert.deepStrictEqual(quiet.opened, []);
  } finally {
    await quiet.close();
  }
});

// Bidi embeddings, overrides and isolates, and the stray zero-width characters cleanText removes.
const INVISIBLE_FORMAT = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

test('replies, /sources, /save and restored history never show bidi overrides or zero-width characters', async () => {
  const {directory, file} = historyDirectory();
  const saveDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-fullscreen-bidi-'));
  const services = {...client, ensureChatServiceAwake: async () => {}, requestChat: async () => ({
    message: 'Live \u202Egnp.exe\u202C answer\u200B [1].\n\nSources:\n1. [Live \u202Eevil\u202C](https://example.com/live)',
    model: 'bidi-model',
    webSources: [{title: 'Live \u202Eevil\u202C\uFEFF', url: 'https://example.com/live'}]
  })};
  const savedFiles = () => fs.readdirSync(saveDirectory).filter(name => name.endsWith('.md')).sort();
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({version: 1, history: [], prompts: [], messages: [
      {role: 'user', content: 'Saved \u2067question\u2069'},
      {role: 'assistant', model: 'saved-model', content: 'Saved \u202Eanswer\u202C [1].', answer: 'Saved \u202Eanswer\u202C [1].', sources: [
        {number: 1, title: 'Saved \u202Etitle\u202C', url: 'https://example.com/saved'}
      ]}
    ]}));
    const ui = await terminalApp({columns: 100, rows: 40, services, historyFile: file, saveDirectory});
    try {
      await ui.expectScreen(/Saved answer \[1\]/);
      await ui.type('Ask\r');
      await ui.expectScreen(/Live gnp\.exe answer \[1\]\.\n+\s*Sources: \[1\] Live evil/);
      await ui.type('/sources\r');
      await ui.expectScreen(/Sources · reply 2 of 2/);
      assert.match(ui.screen(), /› \[1\] Live evil\n.*https:\/\/example\.com\/live/);
      await ui.type('\u001b[D');
      await ui.expectScreen(/Sources · reply 1 of 2/);
      assert.match(ui.screen(), /› \[1\] Saved title\n.*https:\/\/example\.com\/saved/);
      await ui.type('\u001b');
      await ui.type('/save\r');
      await waitFor(() => savedFiles().length === 1);
      const text = fs.readFileSync(path.join(saveDirectory, savedFiles()[0]), 'utf8');
      assert.match(text, /Saved question\n\n## saved-model\n\nSaved answer \[1\]\.\n\nSources: \[\\\[1\\\] Saved title\]\(https:\/\/example\.com\/saved\)\n/);
      assert.match(text, /Live gnp\.exe answer \[1\]\.\n\nSources: \[\\\[1\\\] Live evil\]\(https:\/\/example\.com\/live\)\n$/);
      assert.doesNotMatch(text, INVISIBLE_FORMAT);
      assert.doesNotMatch(ui.raw(), INVISIBLE_FORMAT);
    } finally {
      await ui.close();
    }
    // The transcript saved after the reply holds the cleaned answers and titles. The request
    // history keeps the gateway's text, as it does for every other character cleanText removes.
    assert.doesNotMatch(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).messages), INVISIBLE_FORMAT);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
    fs.rmSync(saveDirectory, {recursive: true, force: true});
  }
});

test('/sources without a cited reply adds a notice and stays in chat', async () => {
  const ui = await terminalApp({services: {
    ...client, ensureChatServiceAwake: async () => {}, requestChat: async () => ({message: 'Uncited answer.'})
  }});
  try {
    await ui.type('/sources\r');
    await waitFor(() => ui.screen().includes('No sources yet. Ask a question that needs research first.'));
    assert.match(ui.screen(), /\/ Chat/);
    await ui.type('Question\r');
    await waitFor(() => ui.screen().includes('Uncited answer.'));
    await ui.type('/sources\r');
    await waitFor(() => ui.screen().match(/No sources yet/g)?.length === 2);
    assert.match(ui.screen(), /\/ Chat/);
    await ui.type('hello');
    await ui.expectScreen(/│ › hello/);
  } finally {
    await ui.close();
  }
});

test('/sources inspects replies restored from saved history, and NO_COLOR still shows the selection', async () => {
  const {directory, file} = historyDirectory();
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({version: 1, history: [], prompts: [], messages: [
      {role: 'user', content: 'Saved question'},
      {role: 'assistant', model: 'saved-model', content: 'Saved answer [1][2].', answer: 'Saved answer [1][2].', answeredAt: '2026-10-30T12:15:00.000Z', sources: [
        {number: 1, title: LONG_TITLE, url: LONG_URL},
        {number: 2, title: 'Saved without a link'}
      ]}
    ]}));
    await withInkColor(async () => {
      const ui = await terminalApp({columns: 80, historyFile: file, env: {NO_COLOR: '1'}});
      try {
        await ui.type('/sources\r');
        await waitFor(() => ui.screen().includes('Sources · reply 1 of 1'));
        assert.match(ui.screen(), /Sources · reply 1 of 1 · saved-model · (\d+ \w{3}( \d{4})? )?\d{2}:\d{2}/);
        assert(ui.screen().replace(/\s+/g, '').includes(`[1]${LONG_TITLE.replace(/\s+/g, '')}${LONG_URL}`), ui.screen());
        assert.match(ui.screen(), /› \[1\] A remarkably/);
        assert.match(ui.screen(), / {2}\[2\] Saved without a link\n\s*\(no link\)/);
        await ui.type('\u001b[B');
        await ui.expectScreen(/› \[2\] Saved without a link/);
        assert.match(ui.screen(), / {2}\[1\] A remarkably/);
        assert.doesNotMatch(ui.raw(), SGR);
      } finally {
        await ui.close();
      }
    });
    await withInkColor(async () => {
      const ui = await terminalApp({historyFile: file});
      try {
        await ui.type('/sources\r');
        await waitFor(() => ui.screen().includes('Sources · reply 1 of 1'));
        const row = ui.screen().split('\n').findIndex(line => line.includes('› [1]'));
        const column = ui.screen().split('\n')[row].indexOf('› [1]');
        assert(ui.emulator.buffer.active.getLine(row).getCell(column).isInverse());
      } finally {
        await ui.close();
      }
    });
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

// A clipboard stand-in that records what it is given; `works` decides whether the copy succeeds.
/** @param {boolean | Error} [works] whether the copy succeeds, or the error it throws */
function fakeClipboard(works = true) {
  const copied = [];
  return {copied, clipboard: {async copy(text) {
    copied.push(text);
    if (works instanceof Error) throw works;
    return works;
  }}};
}

const ESCAPES = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
// Whether the screen shows text, which may be wrapped across lines.
const shows = (ui, text) => ui.screen().replace(/\s+/g, ' ').includes(text);

test('/copy gives the clipboard the latest reply and its source links, without escapes, header or tool lines', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-fullscreen-copy-'));
  const {copied, clipboard} = fakeClipboard();
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    async requestChat(_messages, options) {
      options.onActivity({id: 'search', tool: 'search_web', query: 'copy research', status: 'running'});
      options.onActivity({id: 'search', tool: 'search_web', query: 'copy research', status: 'completed'});
      return citedReply('A **sourced** answer with `code` [1][2].', [
        {number: 1, title: 'First [draft] source', url: 'https://example.com/one'},
        {number: 2, title: 'Second', url: 'https://example.com/two'}
      ], 'copy-model');
    }
  };
  try {
    await withInkColor(async () => {
      const ui = await terminalApp({services, clipboard, saveDirectory: directory});
      try {
        await ui.type('/copy\r');
        await waitFor(() => ui.screen().includes('Nothing to copy yet. Wait for a reply to finish.'));
        assert.deepStrictEqual(copied, []);
        await ui.type('Find sources\r');
        await waitFor(() => ui.screen().includes('A sourced answer'));
        assert.match(ui.screen(), /copy research/);
        assert.match(ui.raw(), SGR, 'the reply on screen is styled');
        await ui.type('/website\r');
        await ui.type('/copy\r');
        await waitFor(() => shows(ui, 'Copied the latest reply (with 2 sources) to the clipboard'));
        assert.deepStrictEqual(copied, [
          'A **sourced** answer with `code` [1][2].\n\n' +
          'Sources: [\\[1\\] First \\[draft\\] source](https://example.com/one) · [\\[2\\] Second](https://example.com/two)\n'
        ]);
        assert.doesNotMatch(copied[0], ESCAPES);
        assert.doesNotMatch(copied[0], /copy-model|copy research|website|Nothing to copy/);
        assert.deepStrictEqual(fs.readdirSync(directory), [], 'a working clipboard writes no file');
        assert.match(ui.screen(), /\/ Chat/);
      } finally {
        await ui.close();
      }
    });
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('/copy during a reply copies the previous completed one and never provisional text', async () => {
  const {state, services} = streamingServices();
  const {copied, clipboard} = fakeClipboard();
  const ui = await terminalApp({services, clipboard});
  try {
    await ui.type('First\r');
    await waitFor(() => Boolean(state.resolve));
    state.onDelta('Early provisional words');
    await waitFor(() => ui.screen().includes('Early provisional words'));
    await ui.type('/copy\r');
    await waitFor(() => ui.screen().includes('Nothing to copy yet. Wait for a reply to finish.'));
    assert.deepStrictEqual(copied, []);
    state.resolve({message: 'First complete answer.'});
    await waitFor(() => ui.screen().includes('First complete answer.'));

    state.resolve = null;
    await ui.type('Second\r');
    await waitFor(() => Boolean(state.resolve));
    state.onDelta('Second provisional words');
    await waitFor(() => ui.screen().includes('Second provisional words'));
    await ui.type('/copy\r');
    await waitFor(() => shows(ui, 'Copied the previous reply to the clipboard. The reply being written is not finished yet'));
    assert.deepStrictEqual(copied, ['First complete answer.\n']);
    assert.match(ui.screen(), /Second provisional words/, 'the reply keeps streaming');
    state.resolve({message: 'Second complete answer.'});
    await waitFor(() => ui.screen().includes('Second complete answer.'));
    await ui.type('/copy\r');
    await waitFor(() => copied.length === 2);
    assert.strictEqual(copied[1], 'Second complete answer.\n');
    await waitFor(() => shows(ui, 'Copied the latest reply to the clipboard'));
  } finally {
    await ui.close();
  }
});

test('/copy saves a new private Markdown file when no clipboard works, and says so', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-fullscreen-copy-file-'));
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async () => citedReply('Ömer’s answer [1].', [{number: 1, title: 'Source', url: 'https://example.com/source'}], 'file-model')
  };
  const replies = () => fs.readdirSync(directory).filter(name => /^otekin-reply-\d{8}-\d{6}(?:-\d+)?\.md$/.test(name)).sort();
  const expected = 'Ömer’s answer [1].\n\nSources: [\\[1\\] Source](https://example.com/source)\n';
  try {
    const failing = fakeClipboard(false);
    // Narrow enough to leave out the sidebar, so wrapped notices read as one text.
    const ui = await terminalApp({columns: 80, services, clipboard: failing.clipboard, saveDirectory: directory});
    try {
      await ui.type('/copy\r');
      await waitFor(() => ui.screen().includes('Nothing to copy yet'));
      assert.deepStrictEqual(fs.readdirSync(directory), [], 'nothing is written without a reply');
      await ui.type('Question\r');
      await waitFor(() => ui.screen().includes('answer [1]'));
      await ui.type('/copy\r');
      await waitFor(() => shows(ui, 'No clipboard available; saved the latest reply (with 1 source) to'));
      assert.strictEqual(replies().length, 1);
      const file = path.join(directory, replies()[0]);
      assert(ui.screen().replace(/\s+/g, '').includes(file.replace(/\s+/g, '')));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), expected);
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepStrictEqual(failing.copied, [expected], 'the clipboard was tried first');
      await ui.type('/copy\r');
      await waitFor(() => replies().length === 2);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), expected, 'an existing file is never replaced');
    } finally {
      await ui.close();
    }

    const throwing = fakeClipboard(new Error('clipboard exploded'));
    const missing = await terminalApp({columns: 80, services, clipboard: throwing.clipboard, saveDirectory: path.join(directory, 'missing')});
    try {
      await missing.type('Question\r');
      await waitFor(() => missing.screen().includes('answer [1]'));
      await missing.type('/copy\r');
      await waitFor(() => shows(missing, 'No clipboard available, and the reply could not be saved (ENOENT). The chat still works.'));
      assert.doesNotMatch(missing.screen(), /exploded/);
      assert.strictEqual(replies().length, 2);
    } finally {
      await missing.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('/copy keeps the draft and the chat scroll position', async () => {
  const {copied, clipboard} = fakeClipboard();
  const answer = Array.from({length: 50}, (_,index) => `Answer line ${index + 1}`).join('\n');
  const ui = await terminalApp({columns: 80, clipboard, services: {
    ...client, ensureChatServiceAwake: async () => {}, requestChat: async () => ({message: answer})
  }});
  const viewport = () => ui.screen().split('\n').slice(2, 25).join('\n');
  const linesBelow = () => Number((ui.screen().match(/↑ (\d+) lines/) || [])[1] || 0);
  const composer = () => ui.screen().split('\n').find(line => line.includes('│ ›')) || '';
  try {
    await ui.type('Long question\r');
    await waitFor(() => ui.screen().includes('Answer line 50'));
    await ui.type('\u001b[5~');
    await ui.expectScreen(/↑ \d+ lines/);
    const before = viewport();
    const below = linesBelow();
    assert(below > 0);
    assert.doesNotMatch(before, /Answer line 50/);
    await ui.type('/co\r');
    await ui.waitUntil(() => copied.length === 1 && linesBelow() > below, 'the copy notice did not arrive below');
    assert.strictEqual(copied[0], `${answer}\n`);
    assert.strictEqual(viewport(), before, 'the reading position stays put');
    // The notice lands below the reading position, so the status line repeats it.
    assert.match(ui.screen(), /Copied the latest reply to the clipboard/);
    assert.match(composer(), /│ › Ask anything/);
    await ui.type('abc\u001b[D');
    await ui.waitUntil(() => /│ › abc/.test(composer()) && ui.emulator.buffer.active.cursorX === composer().indexOf('abc') + 2,
      'the caret did not move left in the draft');
    const row = ui.screen().split('\n').indexOf(composer());
    assert.strictEqual(ui.emulator.buffer.active.cursorY, row);
    assert.strictEqual(ui.emulator.buffer.active.cursorX, composer().indexOf('abc') + 2);
    await ui.type('\u001b[1;5F');
    await ui.expectScreen(/•\s*\n\s*Copied the latest reply to the clipboard/);
  } finally {
    await ui.close();
  }
});

test('/copy copies replies restored from saved history with their source links', async () => {
  const {directory, file} = historyDirectory();
  const {copied, clipboard} = fakeClipboard();
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({version: 1, history: [], prompts: [], messages: [
      {role: 'user', content: 'Saved question'},
      {role: 'assistant', model: 'saved-model', content: 'Saved answer [1].', answer: 'Saved answer [1].', sources: [
        {number: 1, title: 'Saved source', url: 'https://example.com/saved'}
      ]},
      {role: 'notice', content: 'website: https://example.com'}
    ]}));
    const ui = await terminalApp({historyFile: file, clipboard});
    try {
      await ui.type('/copy\r');
      await waitFor(() => shows(ui, 'Copied the latest reply (with 1 source) to the clipboard'));
      assert.deepStrictEqual(copied, ['Saved answer [1].\n\nSources: [\\[1\\] Saved source](https://example.com/saved)\n']);
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

// The saved transcript's entries as "role: content", and how many trim notices it holds.
const savedEntries = file => (chatHistory.loadHistory(file)?.messages || []).map(message => `${message.role}: ${message.content}`);
const trimNotices = file => savedEntries(file).filter(entry => entry === `notice: ${client.TRIMMED_CONTEXT_NOTICE}`).length;

test('a long conversation says once that follow-ups leave out older turns, never in /save, and again after /clear', async () => {
  const {directory, file} = historyDirectory();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  const requests = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => ({message: `Reply ${requests.push(messages)}.`})
  };
  const ask = async (ui, question) => {
    const answered = requests.length + 1;
    await ui.type(`${question}\r`);
    await waitFor(() => ui.screen().includes(`Reply ${answered}.`), `${question} was not answered in time`);
    await waitFor(() => savedEntries(file).at(-1) === `assistant: Reply ${answered}.`);
  };
  try {
    const ui = await terminalApp({services, historyFile: file, saveDirectory});
    try {
      // 14 answered turns and the 15th question still fit in one request.
      for (let turn = 1; turn <= 15; turn += 1) await ask(ui, `Question ${turn}`);
      assert.strictEqual(requests.at(-1)[0].content, 'Question 1');
      assert.strictEqual(trimNotices(file), 0);
      assert.doesNotMatch(ui.screen(), /Older turns stay on screen/);

      await ask(ui, 'Question 16');
      assert.strictEqual(requests.at(-1)[0].content, 'Question 2', 'the 16th request leaves out the first turn');
      await ui.expectScreen(/•\s*\n\s*Older turns stay on screen and in \/save, but follow-ups now send only the\s/);
      assert.strictEqual(trimNotices(file), 1);
      const entries = savedEntries(file);
      assert.strictEqual(entries[entries.indexOf(`notice: ${client.TRIMMED_CONTEXT_NOTICE}`) + 1], 'user: Question 16',
        'the notice comes just before the question it applies to');

      await ask(ui, 'Question 17');
      await ui.type('/retry\r');
      await waitFor(() => ui.screen().includes(`Reply ${requests.length}.`) && requests.length === 18);
      await waitFor(() => savedEntries(file).at(-1) === 'assistant: Reply 18.');
      assert.strictEqual(trimNotices(file), 1, 'later trimming follow-ups and /retry do not repeat it');
      assert(requests.every(request => request.every(message => message.content !== client.TRIMMED_CONTEXT_NOTICE)));
      assert(chatHistory.loadHistory(file).history.every(message => message.content !== client.TRIMMED_CONTEXT_NOTICE));

      await ui.type('/save\r');
      await waitFor(() => ui.screen().includes('Saved the conversation to'));
      const [saved] = fs.readdirSync(saveDirectory);
      const markdown = fs.readFileSync(path.join(saveDirectory, saved), 'utf8');
      assert.match(markdown, /## You\n\nQuestion 1\n/);
      assert.doesNotMatch(markdown, /follow-ups now send/);

      await ui.type('/clear\r');
      await waitFor(() => ui.screen().includes("Hi, I'm Ömer"));
      requests.length = 0;
      for (let turn = 1; turn <= 15; turn += 1) await ask(ui, `Again ${turn}`);
      assert.strictEqual(trimNotices(file), 0);
      await ask(ui, 'Again 16');
      assert.strictEqual(trimNotices(file), 1, '/clear starts a conversation that is told again');
      await ui.expectScreen(/Older turns stay on screen/);
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('a restored conversation whose request history is shorter than its transcript says so on the first follow-up', async () => {
  const {directory, file} = historyDirectory();
  const requests = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => ({message: `Reply ${requests.push(messages)}.`})
  };
  // The transcript shows ten turns; large replies left only the last two in the saved request history.
  const messages = [];
  for (let turn = 1; turn <= 10; turn += 1) {
    messages.push({role: 'user', content: `Old ${turn}`}, {role: 'assistant', model: 'fixture-model', content: `Old answer ${turn}`});
  }
  const history = messages.slice(-4).map(({role, content}) => ({role, content}));
  try {
    chatHistory.saveHistory(file, {history, messages, prompts: []});
    const ui = await terminalApp({services, historyFile: file});
    try {
      assert.doesNotMatch(ui.screen(), /Older turns stay on screen/);
      await ui.type('Follow up\r');
      await waitFor(() => ui.screen().includes('Reply 1.'));
      await ui.expectScreen(/Older turns stay on screen/);
      assert.deepStrictEqual(requestContents(requests[0]), ['Old 9', 'Old answer 9', 'Old 10', 'Old answer 10', 'Follow up']);
      await waitFor(() => savedEntries(file).at(-1) === 'assistant: Reply 1.');
      assert.deepStrictEqual(savedEntries(file).slice(-3), [`notice: ${client.TRIMMED_CONTEXT_NOTICE}`, 'user: Follow up', 'assistant: Reply 1.']);
      await ui.type('Another\r');
      await waitFor(() => savedEntries(file).at(-1) === 'assistant: Reply 2.');
      assert.strictEqual(trimNotices(file), 1);
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('a short restored conversation whose requests carry every turn shows no trim notice', async () => {
  const {directory, file} = historyDirectory();
  const requests = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat: async messages => ({message: `Reply ${requests.push(messages)}.`})
  };
  const messages = [{role: 'user', content: 'Old 1'}, {role: 'assistant', model: 'fixture-model', content: 'Old answer 1'}];
  try {
    chatHistory.saveHistory(file, {history: messages.map(({role, content}) => ({role, content})), messages, prompts: []});
    const ui = await terminalApp({services, historyFile: file});
    try {
      await ui.type('Follow up\r');
      await waitFor(() => savedEntries(file).at(-1) === 'assistant: Reply 1.');
      await ui.type('/retry\r');
      await waitFor(() => savedEntries(file).at(-1) === 'assistant: Reply 2.');
      assert.strictEqual(trimNotices(file), 0);
      assert.doesNotMatch(ui.screen(), /Older turns stay on screen/);
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

// One chat stage the test settles by hand: `release()` lets it succeed, `fail(error)` fails it.
function heldStage() {
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  /** @type {(error: unknown) => void} */
  let fail = () => {};
  const promise = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return {promise, release, fail};
}

// Fails the second question at `stage`, with a draft typed while it was on its way, then /retry and /save.
async function failThenRetry(stage, error) {
  const {directory} = historyDirectory();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  const requests = [];
  const held = {readiness: [], request: []};
  let wakes = 0;
  const services = {
    ...client,
    async ensureChatServiceAwake() {
      wakes += 1;
      if (stage === 'readiness' && wakes === 2) {
        const pending = heldStage();
        held.readiness.push(pending);
        return pending.promise;
      }
    },
    async requestChat(messages) {
      requests.push(messages);
      if (stage === 'request' && requests.length === 2) {
        const pending = heldStage();
        held.request.push(pending);
        return pending.promise;
      }
      return {message: requests.length === 1 ? 'First answer.' : 'Second answer.'};
    }
  };
  const ui = await terminalApp({columns: 160, services, saveDirectory});
  const flat = () => ui.screen().replace(/\s+/g, ' ');
  const composer = () => ui.screen().split('\n').find(line => line.includes('│ ›')) || '';
  try {
    await ui.type('First question\r');
    await ui.expectScreen(/First answer\./);
    await ui.type('Second question\r');
    await waitFor(() => held[stage].length === 1, `the ${stage} stage never started`);
    await ui.type('Draft typed while waiting');
    await ui.expectScreen(/│ › Draft typed while waiting/);
    held[stage][0].fail(error);
    await ui.expectScreen(/CHAT ERROR/);
    await ui.waitUntil(() => /Type \/retry to send it again\./.test(flat()), 'the /retry hint never showed');
    const failed = flat();
    // The draft survives the failure, and the earlier answer is still on screen.
    assert.match(composer(), /│ › Draft typed while waiting/);
    assert.match(failed, /First answer\./);
    const postsAtFailure = requests.length;

    await ui.type('\u0015/retry\r');
    await ui.expectScreen(/Second answer\./);
    await ui.type('/save\r');
    await waitFor(() => fs.readdirSync(saveDirectory).length === 1);
    const markdown = fs.readFileSync(path.join(saveDirectory, fs.readdirSync(saveDirectory)[0]), 'utf8');
    return {failed, postsAtFailure, requests, markdown, ui};
  } catch (thrown) {
    await ui.close();
    throw thrown;
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test('a question stopped at the wake-up check says it was not sent, keeps the draft, and /retry sends it', async () => {
  const result = await failThenRetry('readiness',
    new client.ChatApiError('Chat service did not wake up in time.', {requestId: 'wake-req-1'}));
  const {failed, postsAtFailure, requests, markdown, ui} = result;
  try {
    assert.match(failed, /Chat service did not wake up in time\. \(Request ID: wake-req-1\) Your question was not sent\. Type \/retry to send it again\./);
    assert.match(failed, /Not sent · \/retry sends it again/);
    // The gateway never saw the failed question; /retry sends it with the first turn as context.
    assert.strictEqual(postsAtFailure, 1);
    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(requestContents(requests[1]), ['First question', 'First answer.', 'Second question']);
    assert.match(markdown, /First question[^]*First answer\.[^]*Second question[^]*Second answer\./);
  } finally {
    await ui.close();
  }
});

test('a failed chat request never says it was not sent, keeps the draft, and /retry resends the same request', async () => {
  const result = await failThenRetry('request', new client.ChatApiError(
    'Chat generation is temporarily unavailable. Try again later.', {code: 'generation_unavailable', requestId: 'gen-req-2'}));
  const {failed, postsAtFailure, requests, markdown, ui} = result;
  try {
    assert.match(failed, /Chat generation is temporarily unavailable\. Try again later\. \(Request ID: gen-req-2\) The chat service may have received your question\. Type \/retry to send it again\./);
    assert.doesNotMatch(failed, /not sent/i);
    assert.strictEqual(postsAtFailure, 2);
    assert.strictEqual(requests.length, 3);
    assert.deepStrictEqual(requests[2], requests[1]);
    assert.deepStrictEqual(requestContents(requests[2]), ['First question', 'First answer.', 'Second question']);
    assert.match(markdown, /First question[^]*First answer\.[^]*Second question[^]*Second answer\./);
  } finally {
    await ui.close();
  }
});

test('Esc during the wake-up check cancels quietly and sends nothing', async () => {
  const wake = heldStage();
  const requests = [];
  const services = {
    ...client,
    // Like the real check, it stops as soon as the request is cancelled.
    ensureChatServiceAwake: ({signal}) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new client.ChatApiError('Chat request was cancelled.')), {once: true});
      wake.promise.then(resolve);
    }),
    requestChat: async messages => {requests.push(messages); return {message: 'Unused.'};}
  };
  const ui = await terminalApp({services});
  try {
    await ui.type('Cancel while waking\r');
    await ui.expectScreen(/Connecting to chat service/);
    await ui.type('\u001b');
    await ui.expectScreen(/Cancelled\. Ready for your next message\./);
    wake.release();
    await ui.settle();
    assert.doesNotMatch(ui.screen(), /CHAT ERROR|not sent|\/retry sends/);
    assert.strictEqual(requests.length, 0);
  } finally {
    await ui.close();
  }
});

// The composer's first line on screen.
const composerLine = ui => ui.screen().split('\n').find(line => line.includes('│ ›')) || '';

// Fails the second question at `stage` with nothing typed meanwhile, then sends it again with Enter.
async function failThenResend(stage, error) {
  const {directory, file} = historyDirectory();
  const requests = [];
  const held = {readiness: [], request: []};
  let wakes = 0;
  const services = {
    ...client,
    async ensureChatServiceAwake() {
      wakes += 1;
      if (stage === 'readiness' && wakes === 2) {
        const pending = heldStage();
        held.readiness.push(pending);
        return pending.promise;
      }
    },
    async requestChat(messages) {
      requests.push(messages);
      if (stage === 'request' && requests.length === 2) {
        const pending = heldStage();
        held.request.push(pending);
        return pending.promise;
      }
      return {message: requests.length === 1 ? 'First answer.' : 'Second answer.'};
    }
  };
  const ui = await terminalApp({columns: 160, services, historyFile: file});
  const flat = () => ui.screen().replace(/\s+/g, ' ');
  try {
    await ui.type('First question\r');
    await ui.expectScreen(/First answer\./);
    await ui.type('Second question\r');
    await waitFor(() => held[stage].length === 1, `the ${stage} stage never started`);
    await ui.expectScreen(/│ › Ask anything/);
    held[stage][0].fail(error);
    await ui.expectScreen(/CHAT ERROR/);
    await ui.waitUntil(() => /Press Enter to send it again\./.test(flat()), 'the composer hint never showed');
    await ui.expectScreen(/│ › Second question/);
    const failed = flat();
    const postsAtFailure = requests.length;
    const wakesAtFailure = wakes;
    // The caret is at the end of the restored question.
    const caret = composerLine(ui).indexOf('Second question') + 'Second question'.length;
    await ui.waitUntil(() => ui.emulator.buffer.active.cursorX === caret, 'the caret is not at the end of the question');

    // Enter alone sends it again: one wake-up check and one request.
    await ui.type('\r');
    await ui.expectScreen(/Second answer\./);
    await ui.expectScreen(/│ › Ask anything/);
    assert.strictEqual(wakes, wakesAtFailure + 1);
    // ↑ recalls the question once, then the one before it.
    await ui.type('\u001b[A');
    await ui.expectScreen(/│ › Second question/);
    await ui.type('\u001b[A');
    await ui.expectScreen(/│ › First question/);
    await waitFor(() => chatHistory.loadHistory(file)?.history.length === 4);
    const saved = chatHistory.loadHistory(file);
    return {failed, postsAtFailure, requests, saved, ui};
  } catch (thrown) {
    await ui.close();
    throw thrown;
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test('a question stopped at the wake-up check goes back into an empty composer, and Enter sends it once', async () => {
  const {failed, postsAtFailure, requests, saved, ui} = await failThenResend('readiness',
    new client.ChatApiError('Chat service did not wake up in time.', {requestId: 'wake-req-3'}));
  try {
    assert.match(failed, /Chat service did not wake up in time\. \(Request ID: wake-req-3\) Your question was not sent\. Your question is back in the composer\. Press Enter to send it again\./);
    assert.match(failed, /Not sent · press Enter to send it again/);
    assert.doesNotMatch(failed, /Type \/retry/);
    assert.strictEqual(postsAtFailure, 1);
    // The resent question is the same request a fresh send makes.
    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(requestContents(requests[1]), ['First question', 'First answer.', 'Second question']);
    assert.deepStrictEqual(saved.prompts, ['First question', 'Second question']);
  } finally {
    await ui.close();
  }
});

test('a failed chat request goes back into an empty composer without saying it was not sent', async () => {
  const {failed, postsAtFailure, requests, saved, ui} = await failThenResend('request', new client.ChatApiError(
    'Chat generation is temporarily unavailable. Try again later.', {code: 'generation_unavailable', requestId: 'gen-req-4'}));
  try {
    assert.match(failed, /\(Request ID: gen-req-4\) The chat service may have received your question\. Your question is back in the composer\. Press Enter to send it again\./);
    assert.match(failed, /Press Enter to send it again(?! ·)/);
    assert.doesNotMatch(failed, /not sent|Type \/retry/i);
    assert.strictEqual(postsAtFailure, 2);
    assert.strictEqual(requests.length, 3);
    assert.deepStrictEqual(requests[2], requests[1]);
    assert.deepStrictEqual(requestContents(requests[2]), ['First question', 'First answer.', 'Second question']);
    assert.deepStrictEqual(saved.prompts, ['First question', 'Second question']);
  } finally {
    await ui.close();
  }
});

test('a chat request that never connected says it was not sent, in the error and the status row', async () => {
  const resend = await failThenResend('request',
    new client.ChatApiError('Unable to reach chat service.', {notSent: true}));
  try {
    assert.match(resend.failed, /Unable to reach chat service\. Your question was not sent\. Your question is back in the composer\. Press Enter to send it again\./);
    assert.match(resend.failed, /Not sent · press Enter to send it again/);
    assert.doesNotMatch(resend.failed, /may have received/);
    assert.strictEqual(resend.postsAtFailure, 2);
    assert.deepStrictEqual(requestContents(resend.requests[2]), ['First question', 'First answer.', 'Second question']);
  } finally {
    await resend.ui.close();
  }

  const retry = await failThenRetry('request',
    new client.ChatApiError('Chat service took too long.', {notSent: true}));
  try {
    assert.match(retry.failed, /Chat service took too long\. Your question was not sent\. Type \/retry to send it again\./);
    assert.match(retry.failed, /Not sent · \/retry sends it again/);
    assert.doesNotMatch(retry.failed, /may have received/);
    assert.deepStrictEqual(retry.requests[2], retry.requests[1]);
  } finally {
    await retry.ui.close();
  }
});

// Every request waits until the test answers or fails it, in the order they were sent.
function heldRequests() {
  const requests = [];
  const held = [];
  return {requests, held, services: {
    ...client, ensureChatServiceAwake: async () => {},
    requestChat(messages) {
      requests.push(messages);
      const pending = heldStage();
      held.push(pending);
      return pending.promise;
    }
  }};
}

// The rail item drawn as selected, if any: "› Website ↗" and the like.
const railSelection = ui => (ui.screen().split('\n').map(line => line.slice(0, 27).match(/› (\S.*?)\s*$/)).find(Boolean) || [])[1];

test('a failed question put back in the composer takes focus back from the rail, so Enter sends it once', async () => {
  const failure = new client.ChatApiError('Chat service is busy.', {requestId: 'rail-req-1'});
  const {requests, held, services} = heldRequests();
  const ui = await terminalApp({columns: 110, services});
  try {
    await ui.type('Rail question\r');
    await waitFor(() => held.length === 1);
    // Tab moves focus to the rail while the reply is on its way; ↓↓ selects the website.
    await ui.type('\t\u001b[B\u001b[B');
    await ui.waitUntil(() => railSelection(ui) === 'Website ↗', 'the rail did not select the website');
    held[0].fail(failure);
    // The status row: the error's own hint wraps around the rail.
    await ui.expectScreen(/ {2}Press Enter to send it again\n/);
    await ui.expectScreen(/│ › Rail question/);
    // The rail shows the open view again, not a selection, and the caret is back in the composer.
    await ui.waitUntil(() => railSelection(ui) === 'Chat', 'the rail kept its selection');
    const row = ui.screen().split('\n').indexOf(composerLine(ui));
    await ui.waitUntil(() => ui.emulator.buffer.active.cursorY === row, 'the caret is not in the composer');

    await ui.type('\r');
    await waitFor(() => held.length === 2);
    held[1].release({message: 'Rail answer.'});
    await ui.expectScreen(/Rail answer\./);
    await ui.settle();
    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(requestContents(requests[1]), ['Rail question']);
    assert.deepStrictEqual(ui.opened, [], 'Enter ran no rail item');
    assert.match(composerLine(ui), /│ › Ask anything/);

    // A draft typed meanwhile is not replaced, so focus stays where the user put it.
    await ui.type('Third question\r');
    await waitFor(() => held.length === 3);
    // The rail still has the website selected from before.
    await ui.type('kept draft\t');
    await ui.waitUntil(() => railSelection(ui) === 'Website ↗', 'the rail did not select the website');
    held[2].fail(failure);
    await ui.expectScreen(/ {2}\/retry sends it again\n/);
    await ui.settle();
    assert.strictEqual(railSelection(ui), 'Website ↗', 'the rail keeps focus when nothing was restored');
    assert.match(ui.screen(), /kept draft/);
    assert.strictEqual(requests.length, 3);
  } finally {
    await ui.close();
  }
});

test('a failed question put back in the composer leaves /sources for the chat, so Enter sends it once', async () => {
  const failure = new client.ChatApiError('Chat service is busy.', {requestId: 'sources-req-1'});
  const {requests, held, services} = heldRequests();
  const ui = await terminalApp({columns: 80, services});
  const flat = () => ui.screen().replace(/\s+/g, ' ');
  const openSources = async () => {
    await ui.type('/sources\r');
    await ui.expectScreen(/Sources · reply \d of \d/);
  };
  try {
    await ui.type('First question\r');
    await waitFor(() => held.length === 1);
    held[0].release(citedReply('First cited [1].', [{number: 1, title: 'First source', url: 'https://example.com/first'}]));
    await ui.expectScreen(/First cited \[1\]\./);

    await ui.type('Second question\r');
    await waitFor(() => held.length === 2);
    await openSources();
    held[1].fail(failure);
    // Back in the chat, with the error, its hint and the restored question on screen.
    await ui.waitUntil(() => !ui.screen().includes('Sources · reply'), 'the inspector stayed open');
    await ui.expectScreen(/\/ Chat/);
    await ui.expectScreen(/CHAT ERROR/);
    await ui.waitUntil(() => /Your question is back in the composer\. Press Enter to send it again\./.test(flat()),
      'the error and its hint are not on screen');
    await ui.expectScreen(/│ › Second question/);

    await ui.type('\r');
    await waitFor(() => held.length === 3);
    held[2].release({message: 'Second answer.'});
    await ui.expectScreen(/Second answer\./);
    await ui.settle();
    assert.strictEqual(requests.length, 3);
    assert.deepStrictEqual(requests[2], requests[1], 'Enter resends the same request');
    assert.strictEqual(requestContents(requests[2]).at(-1), 'Second question');
    assert.deepStrictEqual(ui.opened, [], 'Enter opened no source');

    // A failed replacing /retry restores nothing, so the inspector stays open with its selection.
    await ui.type('/retry\r');
    await waitFor(() => held.length === 4);
    await openSources();
    held[3].fail(failure);
    await ui.settle();
    assert.match(ui.screen(), /Sources · reply 1 of 1/);
    assert.match(ui.screen(), /› \[1\] First source/);
    assert.match(ui.screen(), /\/retry sends it again/);
    assert.strictEqual(requests.length, 4);
    assert.deepStrictEqual(ui.opened, []);
  } finally {
    await ui.close();
  }
});

test('a failed //question comes back as typed, and a failed /retry of it comes back escaped', async () => {
  const requests = [];
  const services = {
    ...client, ensureChatServiceAwake: async () => {},
    async requestChat(messages) {
      requests.push(messages);
      if (requests.length < 4) throw new client.ChatApiError('Chat service is busy.');
      return {message: 'Literal answer.'};
    }
  };
  const ui = await terminalApp({services});
  try {
    await ui.type('//literal\r');
    await ui.expectScreen(/│ › \/\/literal/);
    // Enter sends the restored text as a question, not as a command.
    await ui.type('\r');
    await waitFor(() => requests.length === 2);
    await ui.expectScreen(/│ › \/\/literal/);
    // A /retry has no typed text; the question still comes back escaped.
    await ui.type('\u0015/retry\r');
    await waitFor(() => requests.length === 3);
    await ui.expectScreen(/│ › \/\/literal/);
    await ui.type('\r');
    await ui.expectScreen(/Literal answer\./);
    assert.strictEqual(requests.length, 4);
    for (const request of requests) assert.deepStrictEqual(requestContents(request), ['/literal']);
    assert.doesNotMatch(ui.screen(), /Unknown command/);
    // Recall holds the question once.
    await ui.type('\u001b[A');
    await ui.expectScreen(/│ › \/\/literal/);
    await ui.type('\u001b[A');
    await ui.settle();
    assert.match(composerLine(ui), /│ › \/\/literal\s/);
  } finally {
    await ui.close();
  }
});

test('Esc, Ctrl+C or /clear during a request leaves the composer empty', async () => {
  for (const [key, notice] of [
    ['\u001b', /Cancelled\. Ready for your next message\./],
    ['\u0003', /Cancelled\. Ready for your next message\./],
    ['/clear\r', /Conversation cleared/]
  ]) {
    const requests = [];
    const services = {
      ...client, ensureChatServiceAwake: async () => {},
      requestChat(messages, options) {
        requests.push(messages);
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new client.ChatApiError('Chat request was cancelled.')), {once: true});
        });
      }
    };
    const ui = await terminalApp({services});
    try {
      await ui.type('Stop this question\r');
      await waitFor(() => requests.length === 1);
      await ui.type(key);
      await ui.expectScreen(notice);
      await ui.settle();
      assert.match(composerLine(ui), /│ › Ask anything/);
      assert.doesNotMatch(ui.screen(), /CHAT ERROR|back in the composer/);
      assert.strictEqual(requests.length, 1);
    } finally {
      await ui.close();
    }
  }
});

test('a restored conversation scrolls and shows /sources, /save and /copy with the gateway down, never contacting it', async () => {
  const {directory, file} = historyDirectory();
  const saveDirectory = path.join(directory, 'saved');
  fs.mkdirSync(saveDirectory);
  const answer = Array.from({length: 50}, (_,index) => `Saved line ${index + 1}`).join('\n') + ' [1][2]';
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({version: 1, history: [], prompts: ['First saved question', 'Second saved question'], messages: [
      {role: 'user', content: 'First saved question'},
      {role: 'assistant', model: 'saved-model', content: 'Short saved answer.', answeredAt: '2026-10-30T12:00:00.000Z'},
      {role: 'user', content: 'Second saved question'},
      {role: 'assistant', model: 'saved-model', content: answer, answer, answeredAt: '2026-10-30T12:15:00.000Z', sources: [
        {number: 1, title: LONG_TITLE, url: LONG_URL},
        {number: 2, title: 'Second saved source', url: 'https://example.com/second'}
      ]}
    ]}));
    // /save and /copy write the source row's labels, which shorten long titles.
    const reply = `${answer}\n\nSources: [\\[1\\] A remarkably long source title that keeps going…](${LONG_URL}) · [\\[2\\] Second saved source](https://example.com/second)\n`;
    await withDownGateway(async gateway => {
      let clipboardWorks = true;
      const copied = [];
      const clipboard = {async copy(text) {
        copied.push(text);
        return clipboardWorks;
      }};
      // The real chat client, which reads the gateway's address from the environment.
      const ui = await terminalApp({columns: 80, historyFile: file, saveDirectory, clipboard});
      const viewport = () => ui.screen().split('\n').slice(2, 25).join('\n');
      try {
        // The restored conversation is shown at once, with nothing waiting on the wake-up check.
        assert.match(ui.screen(), /Restored your last conversation/);
        assert.match(ui.screen(), /Saved line 50 \[1\]\[2\]/);
        assert.doesNotMatch(ui.screen(), /Waking|Thinking|Researching/);

        await ui.type('\u001b[5~');
        await ui.expectScreen(/↑ \d+ lines/);
        assert.doesNotMatch(viewport(), /Saved line 50/);
        await ui.type('\u001b[1;5H');
        await ui.waitUntil(() => viewport().includes('First saved question'), 'Ctrl+Home did not reach the start');
        assert.match(viewport(), /Short saved answer\./);
        await ui.type('\u001b[1;5F');
        await ui.waitUntil(() => viewport().includes('Saved line 50'), 'Ctrl+End did not return to the end');

        await ui.type('/sources\r');
        await waitFor(() => ui.screen().includes('Sources · reply 1 of 1'));
        assert.match(ui.screen(), /Sources · reply 1 of 1 · saved-model · (\d+ \w{3}( \d{4})? )?\d{2}:\d{2}/);
        assert(ui.screen().replace(/\s+/g, '').includes(`[1]${LONG_TITLE.replace(/\s+/g, '')}${LONG_URL}`), ui.screen());
        assert.match(ui.screen(), / {2}\[2\] Second saved source\n\s*https:\/\/example\.com\/second/);
        await ui.type('\u001b');
        await ui.waitUntil(() => !ui.screen().includes('Sources · reply'), 'Esc did not close the sources');

        await ui.type('/save\r');
        await waitFor(() => fs.readdirSync(saveDirectory).some(name => name.startsWith('otekin-chat-')));
        const [saved] = fs.readdirSync(saveDirectory).filter(name => name.startsWith('otekin-chat-'));
        const markdown = fs.readFileSync(path.join(saveDirectory, saved), 'utf8');
        assert.match(markdown, /^# otekin chat · [^\n]+\n\n## You\n\nFirst saved question\n\n## saved-model · 2026-10-30 \d{2}:\d{2}\n\nShort saved answer\.\n\n## You\n\nSecond saved question\n\n## saved-model · 2026-10-30 \d{2}:\d{2}\n\nSaved line 1\n/);
        assert(markdown.endsWith(reply), markdown);

        await ui.type('/copy\r');
        await waitFor(() => shows(ui, 'Copied the latest reply (with 2 sources) to the clipboard'));
        clipboardWorks = false;
        await ui.type('/copy\r');
        await waitFor(() => shows(ui, 'No clipboard available; saved the latest reply (with 2 sources) to'));
        const [replyFile] = fs.readdirSync(saveDirectory).filter(name => name.startsWith('otekin-reply-'));
        assert.strictEqual(fs.readFileSync(path.join(saveDirectory, replyFile), 'utf8'), reply);
        assert.deepStrictEqual(copied, [reply, reply]);
        assert.strictEqual(gateway.connections(), 0, 'nothing contacted the gateway');

        // Asking proves the gateway is reachable from this test: the readiness check fails and sends nothing.
        await ui.type('A new question\r');
        await waitFor(() => shows(ui, 'Your question was not sent.'));
        assert(gateway.connections() > 0);
        assert(gateway.requests().every(request => request === 'GET /healthz'), gateway.requests().join(', '));
      } finally {
        await ui.close();
      }
    });
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
