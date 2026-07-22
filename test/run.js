'use strict';

const tests = [];

global.test = (name, run) => {
  tests.push({ name, run });
};

require('./chat-client.test');
require('./chat-format.test');
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

  process.stdout.write(`\n${tests.length - failed}/${tests.length} tests passed\n`);
  if (failed > 0) process.exitCode = 1;
})();
