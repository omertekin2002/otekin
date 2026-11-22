'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: spawnProcess } = require('child_process');
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
    const call = { command, args, options, input: null, killed: false, signals: [], unrefed: false, stdinDestroyed: false };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: (signal) => {
        call.killed = true;
        call.signals.push(signal || 'SIGTERM');
        // 'term' is a hung tool that does exit on SIGTERM.
        if (outcome === 'term') {
          child.signalCode = signal || 'SIGTERM';
          child.emit('exit', null, child.signalCode);
        }
      },
      unref: () => { call.unrefed = true; },
      stdin: { on() {}, end(input) { call.input = input; }, destroy() { call.stdinDestroyed = true; } }
    });
    setImmediate(() => {
      if (outcome === 'ENOENT') child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      else if (typeof outcome === 'number') {
        child.exitCode = outcome;
        child.emit('exit', outcome, null);
      }
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
    assert.deepStrictEqual(call.signals, [], 'a tool that exits in time is never signalled');
    assert.strictEqual(call.unrefed, false);
    assert.strictEqual(call.stdinDestroyed, false);
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

test('copyToClipboard lets go of a timed-out tool so it cannot keep otekin running', async () => {
  const { spawn, calls } = fakeSpawn(['hang', 0]);
  const used = await copyToClipboard('x', { platform: 'linux', env: { WAYLAND_DISPLAY: 'w', DISPLAY: ':0' }, spawn, timeoutMs: 20, killGraceMs: 30 });
  assert.strictEqual(used, 'xclip');
  assert.deepStrictEqual(calls[0].signals, ['SIGTERM']);
  assert.strictEqual(calls[0].unrefed, true, 'the timed-out child no longer holds the event loop');
  assert.strictEqual(calls[0].stdinDestroyed, true, 'no pending pipe write either');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepStrictEqual(calls[0].signals, ['SIGTERM', 'SIGKILL'], 'a tool that ignores SIGTERM gets SIGKILL after the grace period');
  // The tool that worked is left alone: its background process keeps serving the selection.
  assert.deepStrictEqual(calls[1].signals, []);
  assert.strictEqual(calls[1].unrefed, false);
  assert.strictEqual(calls[1].stdinDestroyed, false);
});

test('copyToClipboard sends no SIGKILL to a timed-out tool that exited on SIGTERM', async () => {
  const { spawn, calls } = fakeSpawn(['term']);
  assert.strictEqual(await copyToClipboard('x', { platform: 'darwin', env: {}, spawn, timeoutMs: 20, killGraceMs: 30 }), null);
  assert.deepStrictEqual(calls[0].signals, ['SIGTERM']);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepStrictEqual(calls[0].signals, ['SIGTERM']);
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

test('copyToClipboard lets otekin exit while a timed-out tool that ignores SIGTERM keeps running', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-clipboard-'));
  const pidFile = path.join(directory, 'tool.pid');
  // The tool ignores SIGTERM, says it is ready, then would hang for 30 s.
  const tool = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000);`;
  // A stand-in for otekin: one /copy whose only tool times out, then nothing else to do.
  const host = `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'clipboard.js'))})`
    + `.copyToClipboard('x', { timeoutMs: 2000, commands: [{ command: process.execPath, args: ['-e', ${JSON.stringify(tool)}] }] })`
    + `.then(used => process.stdout.write(JSON.stringify(used)));`;
  let hostProcess;
  try {
    const started = Date.now();
    hostProcess = spawnProcess(process.execPath, ['-e', host], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    hostProcess.stdout.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => hostProcess.once('close', resolve));
    const elapsed = Date.now() - started;
    assert.strictEqual(code, 0);
    assert.strictEqual(output, 'null', 'no tool worked');
    assert(elapsed < 15000, `the host exited ${elapsed} ms after starting, not soon after the 2 s timeout`);
    assert(fs.existsSync(pidFile), 'the tool started before the timeout');
    if (process.platform !== 'win32') {
      // Windows' kill() always ends the tool; elsewhere it ignored SIGTERM and outlived the host.
      assert.doesNotThrow(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), 'the tool is still running');
    }
  } finally {
    if (hostProcess && hostProcess.exitCode === null && hostProcess.signalCode === null) hostProcess.kill('SIGKILL');
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {
      // Never started, or already gone.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
