'use strict';

// Run by linear-scans.test.js in its own process: sends worst-case replies of
// MAX_RESPONSE_BYTES through every scan of reply text and prints how long each took.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { MAX_RESPONSE_BYTES, assistantMessageFromResponse } = require('../lib/chat-client');
const { resolveChatResponse } = require('../lib/chat-format');
const { provisionalText } = require('../lib/stream-preview');
const { cleanText } = require('../lib/terminal');
const { saveGeneratedImages } = require('../lib/chat-images');
const { replyMarkdown } = require('../lib/chat-export');

const fill = (unit, tail) => unit.repeat(Math.floor(MAX_RESPONSE_BYTES / unit.length)) + (tail || '');
const inputs = {
  'blank lines': fill('\n\n', 'x'),
  'blank lines with spaces': fill('\n ', 'x'),
  'image markdown': fill('![x](data:image/png;base64,'),
  'image openers': fill('!['),
  'C1 OSC introducers': fill('\u009D'),
  'trailing spaces': fill(' ', 'x') + ' '.repeat(1024)
};
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-worst-case-'));
const paths = {
  resolveChatResponse: (text) => resolveChatResponse({ message: text }),
  assistantMessageFromResponse: (text) => assistantMessageFromResponse({ message: text }),
  provisionalText,
  cleanText,
  saveGeneratedImages: (text) => saveGeneratedImages({ message: text }, { directory }),
  replyMarkdown: (text) => replyMarkdown({ role: 'assistant', content: text })
};
const timings = [];
try {
  for (const [name, text] of Object.entries(inputs)) {
    for (const [label, run] of Object.entries(paths)) {
      const started = process.hrtime.bigint();
      run(text);
      timings.push({ input: name, path: label, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    }
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(timings));
