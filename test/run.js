'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tests = [];

// Never touch the real chat history, including from spawned CLI processes.
const historyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-test-history-'));
process.env.OTEKIN_HISTORY_FILE = path.join(historyDirectory, 'history.json');

global.test = (name, run) => {
  tests.push({ name, run });
};

require('./chat-client.test');
require('./chat-history.test');
require('./chat-format.test');
require('./chat-export.test');
require('./terminal.test');
require('./stream-preview.test');
require('./browser.test');
require('./profile.test');
require('./fullscreen.test');
require('./cli.test');

(async () => {
  let failed = 0;

  for (const item of tests) {
    try {
      await item.run();
      process.stdout.write(`✓ ${item.name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`✗ ${item.name}\n`);
      process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    }
  }

  fs.rmSync(historyDirectory, { recursive: true, force: true });
  process.stdout.write(`\n${tests.length - failed}/${tests.length} tests passed\n`);
  if (failed > 0) process.exitCode = 1;
})();
