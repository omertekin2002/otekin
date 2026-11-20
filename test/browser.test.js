'use strict';

const assert = require('assert');
const fs = require('fs');
const { browserCommand } = require('../lib/browser');
const { safeHttpUrl } = require('../lib/chat-format');

const LINKEDIN = 'https://www.linkedin.com/in/ömer-tekin/';
const ENCODED = 'https://www.linkedin.com/in/%C3%B6mer-tekin/';
const WINDOWS_ENV = { SystemRoot: 'C:\\Windows' };
const RUNDLL32 = 'C:\\Windows\\System32\\rundll32.exe';
const PLATFORMS = ['darwin', 'win32', 'linux', 'freebsd'];

// The URL argument each platform's launcher receives.
function launchedUrl(platform, url) {
  const launch = browserCommand(platform, url, WINDOWS_ENV);
  assert.ok(launch, `${platform} should open ${url}`);
  return launch.args[launch.args.length - 1];
}

test('browser command uses open on macOS', () => {
  assert.deepStrictEqual(browserCommand('darwin', LINKEDIN), { command: 'open', args: [ENCODED] });
});

test('browser command uses rundll32 with the URL as one argument on Windows, never cmd.exe', () => {
  assert.deepStrictEqual(browserCommand('win32', LINKEDIN, WINDOWS_ENV), {
    command: RUNDLL32,
    args: ['url.dll,FileProtocolHandler', ENCODED]
  });
});

test('browser command finds rundll32 under SystemRoot, windir, or C:\\Windows', () => {
  assert.strictEqual(browserCommand('win32', LINKEDIN, { SystemRoot: 'D:\\WINNT' }).command,
    'D:\\WINNT\\System32\\rundll32.exe');
  assert.strictEqual(browserCommand('win32', LINKEDIN, { windir: 'E:\\Win' }).command, 'E:\\Win\\System32\\rundll32.exe');
  assert.strictEqual(browserCommand('win32', LINKEDIN, {}).command, RUNDLL32);
});

if (process.platform === 'win32') {
  test('the Windows launcher exists on this machine', () => {
    assert.ok(fs.existsSync(browserCommand('win32', LINKEDIN).command));
  });
}

test('browser command defaults to xdg-open on Linux and other platforms', () => {
  for (const platform of ['linux', 'freebsd']) {
    assert.deepStrictEqual(browserCommand(platform, LINKEDIN), { command: 'xdg-open', args: [ENCODED] });
  }
});

test('cmd.exe metacharacters in a link cannot reach a shell on Windows', () => {
  for (const character of ['&', '|', '^', '%', '(', ')', '<', '>', '"']) {
    const url = `https://evil.example/?q=1${character}calc.exe`;
    for (const value of [url, safeHttpUrl(url)]) {
      const launch = browserCommand('win32', value, WINDOWS_ENV);
      assert.ok(launch, `should open ${url}`);
      assert.strictEqual(launch.command, RUNDLL32, character);
      assert.ok(!/(^|\\)cmd(\.exe)?$/i.test(launch.command), character);
      assert.strictEqual(launch.args.length, 2, character);
      assert.strictEqual(launch.args[0], 'url.dll,FileProtocolHandler');
      // One argument without whitespace or quotes, so Node passes it to rundll32 unquoted and unsplit.
      assert.ok(launch.args[1].startsWith('https://evil.example/?q=1'), character);
      assert.ok(!/[\s"]/.test(launch.args[1]), character);
    }
  }
});

test('browser command keeps the issue example intact as one argument on Windows', () => {
  assert.deepStrictEqual(browserCommand('win32', safeHttpUrl('https://evil.example/?q=1&calc.exe'), WINDOWS_ENV), {
    command: RUNDLL32,
    args: ['url.dll,FileProtocolHandler', 'https://evil.example/?q=1&calc.exe']
  });
});

test('already-encoded URLs pass through unchanged and unencoded ones are encoded once', () => {
  const encoded = 'https://de.wikipedia.org/wiki/M%C3%BCller';
  for (const platform of PLATFORMS) {
    assert.strictEqual(launchedUrl(platform, encoded), encoded, platform);
    assert.strictEqual(launchedUrl(platform, safeHttpUrl(encoded)), encoded, platform);
    assert.strictEqual(launchedUrl(platform, 'https://de.wikipedia.org/wiki/Müller'), encoded, platform);
    assert.strictEqual(launchedUrl(platform, safeHttpUrl('https://de.wikipedia.org/wiki/Müller')), encoded, platform);
    assert.strictEqual(launchedUrl(platform, 'https://example.com/a b?q=x%20y'), 'https://example.com/a%20b?q=x%20y',
      platform);
    assert.strictEqual(launchedUrl(platform, LINKEDIN), ENCODED, platform);
  }
});

test('browser command leaves plain URLs unchanged', () => {
  assert.deepStrictEqual(browserCommand('linux', 'https://omertekin2002.github.io/resume').args, [
    'https://omertekin2002.github.io/resume'
  ]);
  assert.deepStrictEqual(browserCommand('darwin', 'http://127.0.0.1:9/').args, ['http://127.0.0.1:9/']);
});

test('browser command refuses links that are not http(s) or are malformed', () => {
  const refused = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'file://C:/Windows/System32/calc.exe',
    'data:text/html,<script>alert(1)</script>',
    'mailto:someone@example.com',
    'calc.exe',
    'C:\\Windows\\System32\\calc.exe',
    '//evil.example/',
    'https://',
    'https://exa mple.com/',
    'https://example.com/\nnext',
    '',
    null,
    undefined,
    42
  ];
  for (const platform of PLATFORMS) {
    for (const url of refused) {
      assert.strictEqual(browserCommand(platform, url, WINDOWS_ENV), null, `${platform}: ${String(url)}`);
    }
  }
});
