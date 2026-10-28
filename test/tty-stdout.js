'use strict';

// Preloaded into CLI runs by cli.test.js: piped stdout reports itself as a terminal.
const [columns, rows] = (process.env.OTEKIN_TEST_TTY || '60x15').split('x').map(Number);
Object.assign(process.stdout, { isTTY: true, columns, rows });
