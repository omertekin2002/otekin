'use strict';

const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { cleanText } = require('./terminal');

const UV_VERSION = '0.13.7';

/** Run an executable directly, preserving its output and failure status. */
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

/** Dependency overrides let tests exercise installation without downloading tools. */
async function installPilcrow({ upgrade = false } = {}, {
  run = runCommand,
  fetchImpl = fetch,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  stdout = process.stdout
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

module.exports = { installPilcrow, runCommand };
