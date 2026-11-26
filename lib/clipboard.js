'use strict';

const { spawn } = require('child_process');

// Long enough for a slow clipboard tool, short enough that a hung one can't hold up /copy for long.
const CLIPBOARD_TIMEOUT_MS = 3000;

// How long a timed-out tool gets to honour SIGTERM before it is sent SIGKILL.
const CLIPBOARD_KILL_GRACE_MS = 1000;

// Gives up on a tool that timed out. SIGTERM first, as a well-behaved tool expects. A wedged
// xclip, xsel or wl-copy may ignore it, so the child is also unref'd and its stdin destroyed:
// neither the process handle nor a pending pipe write then keeps otekin running after /exit.
// SIGKILL follows after a grace period on a timer that is itself unref'd. It signals the pid
// only, never the detached process group.
function abandonClipboardCommand(child, killGraceMs) {
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  try {
    if (child.stdin) child.stdin.destroy();
  } catch {
    // Already closed.
  }
  try {
    child.unref();
  } catch {
    // Nothing holds the process open.
  }
  const escalation = setTimeout(() => {
    // exitCode or signalCode is set once the tool has exited, so a reused pid is never signalled.
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, killGraceMs);
  escalation.unref();
}

// The clipboard tools to try, in order. Pure, so each platform can be tested anywhere.
// Windows uses clip.exe, which ships with every Windows version and starts instantly; fed
// UTF-16LE with a byte-order mark, it keeps non-ASCII text such as "Ömer" intact. PowerShell's
// Set-Clipboard takes a second or more to start and reads stdin in the console's code page,
// which garbles the same text unless the console encoding is changed first.
function clipboardCommands(platform, env) {
  const vars = env || {};
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ command: 'clip', args: [] }];
  const commands = [];
  if (vars.WAYLAND_DISPLAY) commands.push({ command: 'wl-copy', args: [] });
  if (vars.DISPLAY) {
    commands.push({ command: 'xclip', args: ['-selection', 'clipboard'] });
    commands.push({ command: 'xsel', args: ['--clipboard', '--input'] });
  }
  return commands;
}

// The bytes a platform's clipboard tool reads from stdin.
function clipboardInput(platform, text) {
  if (platform === 'win32') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return Buffer.from(text, 'utf8');
}

// Runs one tool with the text on stdin and resolves whether it exited 0 in time.
// Never rejects: a missing tool (ENOENT), a failure or a timeout all resolve false.
function runClipboardCommand(candidate, input, options) {
  const opts = options || {};
  const spawnProcess = opts.spawn || spawn;
  const timeoutMs = opts.timeoutMs || CLIPBOARD_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs || CLIPBOARD_KILL_GRACE_MS;
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let timer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      // No shell. xclip, xsel and wl-copy keep a background process serving the selection,
      // so stdout and stderr are ignored (it would hold the pipes open) and only the exit counts.
      // detached on POSIX lets that process outlive the terminal; on Windows it would open a console.
      child = spawnProcess(candidate.command, candidate.args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        detached: opts.platform !== 'win32'
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      abandonClipboardCommand(child, killGraceMs);
      finish(false);
    }, timeoutMs);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
    if (child.stdin) {
      // A tool that exits before reading everything closes the pipe; its exit code decides.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// Copies text with the first clipboard tool that works. Resolves the tool's name, or null when none did.
async function copyToClipboard(text, options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const commands = opts.commands || clipboardCommands(platform, opts.env || process.env);
  const input = clipboardInput(platform, text);
  for (const candidate of commands) {
    if (await runClipboardCommand(candidate, input, { ...opts, platform })) return candidate.command;
  }
  return null;
}

module.exports = { CLIPBOARD_TIMEOUT_MS, clipboardCommands, clipboardInput, copyToClipboard };
