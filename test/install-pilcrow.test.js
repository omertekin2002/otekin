'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { installPilcrow, runCommand } = require('../lib/install-pilcrow');

function fixture({ platform = 'linux', available = 'path', failure = '', onBootstrap } = {}) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const home = windows ? "C:\\Users\\Test O'Name" : "/home/Test O'Name";
  const bin = paths.join(home, '.local', 'bin');
  const calls = [];
  let output = '';
  let bootstrapped = false;
  let installerFile;
  const deps = {
    platform, home,
    env: { PATH: bin },
    stdout: { write: (text) => { output += text; } },
    fetchImpl: async (url) => {
      calls.push({ url });
      return { ok: failure !== 'download', status: 503, text: async () => '# official installer fixture' };
    },
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'sh' || command === 'powershell.exe') {
        installerFile = args.at(-1);
        assert.strictEqual(fs.readFileSync(installerFile, 'utf8'), '# official installer fixture');
        if (onBootstrap) onBootstrap(command, args, options);
        if (failure === 'bootstrap') throw Object.assign(new Error('bootstrap failed'), { exitCode: 7 });
        bootstrapped = true;
      } else if (args.includes('install')) {
        if (failure === 'install') throw Object.assign(new Error('PyPI unavailable'), { exitCode: 2 });
      } else if (args.includes('dir')) {
        return { stdout: failure === 'directory' ? '' : bin + '\n', stderr: '' };
      } else if (command.endsWith(windows ? 'pilcrow.exe' : 'pilcrow')) {
        if (failure === 'verify') throw new Error('broken executable');
        return { stdout: '0.1.1\n', stderr: '' };
      } else if (args[0] === '--version') {
        if (failure === 'permission') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const found = command === 'uv' ? available === 'path' : available === 'managed' || bootstrapped;
        if (!found) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return { stdout: 'uv 0.13.7\n', stderr: '' };
      } else throw new Error(`Unexpected command ${command}`);
      return { stdout: '', stderr: '' };
    }
  };
  return { deps, calls, bin, output: () => output, installerFile: () => installerFile };
}

test('Pilcrow uses existing uv, installs the PyPI package, and verifies its actual executable', async () => {
  const f = fixture();
  await installPilcrow({}, f.deps);
  assert.deepStrictEqual(f.calls.find((call) => call.args?.includes('install')).args, [
    '--no-config', 'tool', 'install', '--python', '3.12', '--default-index', 'https://pypi.org/simple', 'pilcrow-docx'
  ]);
  assert.strictEqual(f.calls.at(-1).command, path.posix.join(f.bin, 'pilcrow'));
  assert.match(f.output(), /Pilcrow 0\.1\.1 is installed/);
  assert.doesNotMatch(f.output(), /Add this directory/);
  assert.ok(!f.calls.some((call) => call.url));
  await installPilcrow({}, f.deps);
  assert.ok(!f.calls.some((call) => call.args?.includes('--upgrade')));
});

test('Pilcrow only requests upgrades explicitly and explains a missing PATH entry', async () => {
  const f = fixture({ available: 'managed' });
  f.deps.env.PATH = '/somewhere/else';
  await installPilcrow({ upgrade: true }, f.deps);
  const install = f.calls.find((call) => call.args?.includes('install'));
  assert.ok(install.command.endsWith('/otekin/uv/uv'));
  assert.ok(install.args.includes('--upgrade'));
  assert.match(f.output(), /Add this directory to PATH/);
  assert.ok(f.output().includes(f.bin));
  assert.ok(!f.calls.some((call) => call.url));
});

test('Pilcrow bootstraps uv on Linux, macOS, and Windows without interpolating paths into a shell', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const f = fixture({ platform, available: 'missing', onBootstrap: (command, args, options) => {
      assert.ok(options.env.UV_UNMANAGED_INSTALL.endsWith(platform === 'win32' ? '\\otekin\\uv' : '/otekin/uv'));
      if (platform === 'darwin') assert.match(options.env.UV_UNMANAGED_INSTALL, /Library\/Application Support/);
      assert.ok(options.env.UV_UNMANAGED_INSTALL.includes("Test O'Name"));
      assert.strictEqual(command, platform === 'win32' ? 'powershell.exe' : 'sh');
      assert.strictEqual(options.env.PATH, f.bin);
      if (platform === 'win32') assert.deepStrictEqual(args.slice(0, -1), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
      else assert.strictEqual(args.length, 1);
    } });
    await installPilcrow({}, f.deps);
    assert.match(f.calls.find((call) => call.url).url, /^https:\/\/astral\.sh\/uv\/0\.13\.7\/install\.(sh|ps1)$/);
    assert.ok(!fs.existsSync(f.installerFile()));
    assert.match(f.output(), /Pilcrow 0\.1\.1 is installed/);
  }
});

test('Pilcrow stops on download, bootstrap, install, executable, or permission failures', async () => {
  for (const failure of ['download', 'bootstrap', 'install', 'verify', 'directory', 'permission']) {
    const f = fixture({ failure, available: ['download', 'bootstrap'].includes(failure) ? 'missing' : 'path' });
    await assert.rejects(installPilcrow({}, f.deps));
    assert.doesNotMatch(f.output(), /is installed/);
    if (f.installerFile()) assert.ok(!fs.existsSync(f.installerFile()));
    if (['download', 'bootstrap', 'permission'].includes(failure)) {
      assert.ok(!f.calls.some((call) => call.args?.includes('install')));
    }
  }
});

test('Pilcrow rejects unsupported platforms before downloading or executing anything', async () => {
  const f = fixture();
  f.deps.platform = 'freebsd';
  await assert.rejects(installPilcrow({}, f.deps), /supports Linux, macOS, and Windows/);
  assert.strictEqual(f.calls.length, 0);
});

test('installer process runner captures output, propagates failures, and cleans signal handlers', async () => {
  const before = process.listenerCount('SIGINT');
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { capture: true });
  assert.strictEqual(result.stdout, 'ok');
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(7)'], { capture: true }),
    (error) => error.exitCode === 7 && /bad/.test(error.message));
  await assert.rejects(runCommand(path.join(__dirname, 'nonexistent-installer'), [], { capture: true }),
    (error) => error.code === 'ENOENT');
  assert.strictEqual(process.listenerCount('SIGINT'), before);
});
