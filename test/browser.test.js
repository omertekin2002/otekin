'use strict';

const assert = require('assert');
const { browserCommand } = require('../lib/browser');

const LINKEDIN = 'https://www.linkedin.com/in/ömer-tekin/';
const ENCODED = 'https://www.linkedin.com/in/%C3%B6mer-tekin/';

test('browser command uses open on macOS', () => {
  assert.deepStrictEqual(browserCommand('darwin', LINKEDIN), { command: 'open', args: [ENCODED] });
});

test('browser command uses cmd start with an empty title on Windows', () => {
  assert.deepStrictEqual(browserCommand('win32', LINKEDIN), {
    command: 'cmd',
    args: ['/c', 'start', '', ENCODED]
  });
});

test('browser command defaults to xdg-open on Linux and other platforms', () => {
  for (const platform of ['linux', 'freebsd']) {
    assert.deepStrictEqual(browserCommand(platform, LINKEDIN), { command: 'xdg-open', args: [ENCODED] });
  }
});

test('browser command leaves plain URLs unchanged and passes malformed ones through', () => {
  assert.deepStrictEqual(browserCommand('linux', 'https://omertekin2002.github.io/resume').args, [
    'https://omertekin2002.github.io/resume'
  ]);
  // encodeURI throws on a lone surrogate; the URL is passed through unchanged.
  assert.deepStrictEqual(browserCommand('darwin', 'https://example.com/\uD800').args, ['https://example.com/\uD800']);
});
