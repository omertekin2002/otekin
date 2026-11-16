'use strict';

// Preloaded into CLI runs by cli.test.js: piped stdin reports itself as a terminal.
Object.assign(process.stdin, { isTTY: true });
