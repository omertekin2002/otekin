'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clipboardCommands, clipboardInput, copyToClipboard } = require('../lib/clipboard');

test('clipboardCommands picks the clipboard tools for each platform', () => {
  assert.deepStrictEqual(clipboardCommands('darwin', {}), [{ command: 'pbcopy', args: [] }]);
  assert.deepStrictEqual(clipboardCommands('win32', { DISPLAY: ':0' }), [{ command: 'clip', args: [] }]);
  assert.deepStrictEqual(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] }
  ]);
  assert.deepStrictEqual(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' }), [{ command: 'wl-copy', args: [] }]);
  assert.deepStrictEqual(clipboardCommands('freebsd', { DISPLAY: ':0' }), [
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] }
  ]);
  assert.deepStrictEqual(clipboardCommands('linux', {}), []);
  assert.deepStrictEqual(clipboardCommands('linux', { WAYLAND_DISPLAY: '', DISPLAY: '' }), []);
  assert.deepStrictEqual(clipboardCommands('linux'), []);
});

test('clipboardInput sends UTF-8, and UTF-16LE with a byte-order mark on Windows', () => {
  const text = 'Ömer · 日本 🙂\n';
  assert.deepStrictEqual(clipboardInput('linux', text), Buffer.from(text, 'utf8'));
  const windows = clipboardInput('win32', text);
  assert.deepStrictEqual([...windows.subarray(0, 2)], [0xff, 0xfe]);
  assert.deepStrictEqual([...windows.subarray(2, 4)], [0xd6, 0x00], 'Ö is U+00D6');
  assert.strictEqual(windows.subarray(2).toString('utf16le'), text);
});

// A spawn stand-in: each call follows the next scripted outcome.
function fakeSpawn(outcomes) {
  const calls = [];
  const spawn = (command, args, options) => {
    const outcome = outcomes[calls.length];
    const call = { command, args, options, input: null, killed: false };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), {
      kill: () => { call.killed = true; },
      stdin: { on() {}, end(input) { call.input = input; } }
    });
    setImmediate(() => {
      if (outcome === 'ENOENT') child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      else if (typeof outcome === 'number') child.emit('exit', outcome, null);
    });
    return child;
  };
  return { spawn, calls };
}

test('copyToClipboard moves past a missing or failing tool to the first one that works', async () => {
  const { spawn, calls } = fakeSpawn(['ENOENT', 1, 0, 0]);
  const used = await copyToClipboard('Ömer', { platform: 'linux', env: { WAYLAND_DISPLAY: 'w', DISPLAY: ':0' }, spawn });
  assert.strictEqual(used, 'xsel');
  assert.deepStrictEqual(calls.map(call => call.command), ['wl-copy', 'xclip', 'xsel']);
  for (const call of calls) {
    assert.deepStrictEqual(call.input, Buffer.from('Ömer'));
    assert.deepStrictEqual(call.options.stdio, ['pipe', 'ignore', 'ignore']);
    assert.strictEqual(call.options.shell, undefined, 'no shell');
  }

  const second = fakeSpawn(['ENOENT', 0]);
  assert.strictEqual(await copyToClipboard('x', { platform: 'linux', env: { WAYLAND_DISPLAY: 'w', DISPLAY: ':0' }, spawn: second.spawn }), 'xclip');
  assert.strictEqual(second.calls.length, 2);

  const windows = fakeSpawn([0]);
  assert.strictEqual(await copyToClipboard('Ömer', { platform: 'win32', env: {}, spawn: windows.spawn }), 'clip');
  assert.strictEqual(windows.calls[0].input.subarray(2).toString('utf16le'), 'Ömer');
  assert.strictEqual(windows.calls[0].options.detached, false, 'no console window on Windows');
});

test('copyToClipboard resolves null when every tool fails, there are none, or spawn throws', async () => {
  const failing = fakeSpawn(['ENOENT', 'ENOENT', 2]);
  assert.strictEqual(await copyToClipboard('x', { platform: 'linux', env: { WAYLAND_DISPLAY: 'w', DISPLAY: ':0' }, spawn: failing.spawn }), null);
  assert.strictEqual(failing.calls.length, 3);
  const none = fakeSpawn([]);
  assert.strictEqual(await copyToClipboard('x', { platform: 'linux', env: {}, spawn: none.spawn }), null);
  assert.strictEqual(none.calls.length, 0);
  const throwing = () => { throw new Error('spawn failed'); };
  assert.strictEqual(await copyToClipboard('x', { platform: 'darwin', env: {}, spawn: throwing }), null);
});

test('copyToClipboard stops a hung tool after its timeout and tries the next', async () => {
  const { spawn, calls } = fakeSpawn(['hang', 0]);
  const started = Date.now();
  const used = await copyToClipboard('x', { platform: 'linux', env: { WAYLAND_DISPLAY: 'w', DISPLAY: ':0' }, spawn, timeoutMs: 50 });
  assert.strictEqual(used, 'xclip');
  assert.strictEqual(calls[0].killed, true);
  assert(Date.now() - started < 2000);
});

test('copyToClipboard runs real processes, skipping a missing command and a hung one', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-clipboard-'));
  const output = path.join(directory, 'clipboard.txt');
  try {
    const used = await copyToClipboard('Ömer [1]\n', {
      platform: process.platform,
      timeoutMs: 1500,
      commands: [
        { command: path.join(directory, 'no-such-clipboard-tool'), args: [] },
        { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] },
        { command: process.execPath, args: ['-e', 'process.exit(3)'] },
        { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(output)}, require('fs').readFileSync(0))`] }
      ]
    });
    assert.strictEqual(used, process.execPath);
    assert.deepStrictEqual(fs.readFileSync(output), clipboardInput(process.platform, 'Ömer [1]\n'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
