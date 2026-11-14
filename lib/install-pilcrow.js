'use strict';

const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { cleanText } = require('./terminal');

const UV_VERSION = '0.13.7';
const UV_INSTALL_HELP = 'uv is not installed. Install it from https://docs.astral.sh/uv/getting-started/installation/ and run "otekin pilcrow" again.';

/**
 * The streams the uv prompt reads answers from and writes to. A stream that is not a
 * terminal (`isTTY` unset or false) makes the prompt refuse without reading anything.
 * @typedef {NodeJS.ReadableStream & { isTTY?: boolean }} PromptInput
 * @typedef {NodeJS.WritableStream & { isTTY?: boolean }} PromptOutput
 */

/**
 * Ask on a terminal whether to install uv. Resolves true only for an explicit yes.
 * @param {{ input?: PromptInput, output?: PromptOutput }} [streams]
 * @returns {Promise<boolean>}
 */
function confirmUvInstall({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) return Promise.reject(new Error(UV_INSTALL_HELP));
  return new Promise((resolve, reject) => {
    const prompt = readline.createInterface({ input, output, terminal: false });
    let finished = false;
    const finish = (answer, error = null) => {
      if (finished) return;
      finished = true;
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      prompt.close();
      if (error) reject(error);
      else resolve(answer);
    };
    const interrupt = () => finish(false, Object.assign(new Error('Installation cancelled.'), { exitCode: 130 }));
    const terminate = () => finish(false, Object.assign(new Error('Installation cancelled.'), { exitCode: 143 }));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    prompt.once('close', () => finish(false));
    prompt.on('line', (line) => {
      const answer = line.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') finish(true);
      else if (answer === '' || answer === 'n' || answer === 'no') finish(false);
      else output.write('Please answer y or n. Install uv? [y/N] ');
    });
    output.write('uv is not installed. otekin can download and run Astral\'s official uv installer.\n' +
      'It will then install Python 3.12 if needed and Pilcrow from PyPI.\n' +
      'Install uv? [y/N] ');
  });
}

/**
 * Run an executable directly, preserving its output and failure status.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, capture?: boolean }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runCommand(command, args, { env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let interrupted = null;
    const interrupt = () => { interrupted = 'SIGINT'; child.kill('SIGINT'); };
    const terminate = () => { interrupted = 'SIGTERM'; child.kill('SIGTERM'); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-65536); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    }
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (code === 0 && !interrupted) return resolve({ stdout, stderr });
      const stoppedBy = interrupted || signal;
      const exitCode = stoppedBy === 'SIGINT' ? 130 : stoppedBy === 'SIGTERM' ? 143 : code || 1;
      reject(Object.assign(new Error(
        stoppedBy ? `Installation stopped (${stoppedBy}).` :
          `${path.basename(command)} failed (exit ${exitCode}).${stderr.trim() ? '\n' + cleanText(stderr.trim()) : ''}`
      ), { exitCode }));
    });
  });
}

function uvDirectory(platform, home, env) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const data = platform === 'win32' ? env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local') :
    platform === 'darwin' ? paths.join(home, 'Library', 'Application Support') :
      env.XDG_DATA_HOME || paths.join(home, '.local', 'share');
  return paths.join(data, 'otekin', 'uv');
}

/**
 * Dependency overrides let tests exercise installation without downloading tools.
 * @typedef {object} InstallDependencies
 * @property {typeof runCommand} [run] runs an executable, like runCommand
 * @property {(url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean, status: number, text(): Promise<string> }>} [fetchImpl]
 *   downloads the uv installer, like fetch
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [platform] a process.platform value; only linux, darwin and win32 are supported
 * @property {string} [home] the user's home directory
 * @property {PromptOutput} [stdout] receives progress text, and is the prompt's output
 * @property {PromptInput} [stdin] the prompt's input
 * @property {typeof confirmUvInstall} [confirm] asks whether to install uv, like confirmUvInstall
 */

/**
 * @param {{ upgrade?: boolean, nonInteractive?: boolean }} [options]
 * @param {InstallDependencies} [dependencies]
 */
async function installPilcrow({ upgrade = false, nonInteractive = false } = {}, {
  run = runCommand,
  fetchImpl = fetch,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  stdout = process.stdout,
  stdin = process.stdin,
  confirm = confirmUvInstall
} = {}) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) {
    throw new Error('The Pilcrow installer supports Linux, macOS, and Windows. See https://github.com/omertekin2002/Pilcrow for manual installation.');
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const managedDirectory = uvDirectory(platform, home, env);
  const managedUv = paths.join(managedDirectory, platform === 'win32' ? 'uv.exe' : 'uv');
  let uv;
  for (const candidate of ['uv', managedUv]) {
    try {
      await run(candidate, ['--version'], { env, capture: true });
      uv = candidate;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  if (!uv) {
    if (nonInteractive) throw new Error(UV_INSTALL_HELP);
    if (!await confirm({ input: stdin, output: stdout })) {
      stdout.write('Installation cancelled. Nothing was installed.\n');
      return;
    }
    stdout.write('Installing uv from astral.sh for your user account…\n');
    const extension = platform === 'win32' ? 'ps1' : 'sh';
    const response = await fetchImpl(`https://astral.sh/uv/${UV_VERSION}/install.${extension}`, {
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Could not download the uv installer (HTTP ${response.status}).`);
    const script = await response.text();
    if (!script.trim() || Buffer.byteLength(script) > 1024 * 1024) {
      throw new Error('The uv installer download was empty or too large.');
    }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'otekin-uv-'));
    try {
      const filename = path.join(temp, `install.${extension}`);
      await fs.writeFile(filename, script, { mode: 0o600 });
      // Astral's unmanaged mode leaves shell profiles and PATH unchanged.
      const installerEnv = { ...env, UV_UNMANAGED_INSTALL: managedDirectory };
      const command = platform === 'win32' ? 'powershell.exe' : 'sh';
      const args = platform === 'win32'
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filename]
        : [filename];
      await run(command, args, { env: installerEnv });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
    uv = managedUv;
    await run(uv, ['--version'], { env, capture: true });
  }

  stdout.write(upgrade ? 'Upgrading Pilcrow from PyPI…\n' : 'Installing Pilcrow from PyPI…\n');
  const args = ['--no-config', 'tool', 'install', '--python', '3.12',
    '--default-index', 'https://pypi.org/simple', 'pilcrow-docx'];
  if (upgrade) args.push('--upgrade');
  await run(uv, args, { env });
  const result = await run(uv, ['--no-config', 'tool', 'dir', '--bin'], { env, capture: true });
  const binDirectory = result.stdout.trim();
  if (!paths.isAbsolute(binDirectory)) throw new Error('uv did not return an absolute executable directory.');
  const executable = paths.join(binDirectory, platform === 'win32' ? 'pilcrow.exe' : 'pilcrow');
  const version = await run(executable, ['--version'], { env, capture: true });
  stdout.write(`Pilcrow ${cleanText(version.stdout.trim())} is installed.\n`);
  stdout.write(`Executable: ${cleanText(executable)}\n`);
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const normalize = (value) => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  if (!pathValue.split(paths.delimiter).filter(Boolean).some((entry) => normalize(entry) === normalize(binDirectory))) {
    stdout.write(`Add this directory to PATH and reopen your terminal:\n  ${cleanText(binDirectory)}\n`);
  }
  stdout.write('Then run: pilcrow --help\n');
}

module.exports = { installPilcrow, runCommand, confirmUvInstall };
