'use strict';

const assert = require('assert');
const { isSpace, hideCompleteImageData, hidePartialImageData } = require('../lib/image-data');

// The regular expressions these helpers replace. They are only safe on short input.
const completeRegex = (text) => text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{200,}/gi, '#');
const partialRegex = (text) => text.replace(/data:image\/[^\s)]*(?:\s+[A-Za-z0-9+/=]{40,})*/gi, '#');

test('image data scanning treats exactly the characters of \\s as whitespace', () => {
  for (let code = 0; code <= 0xffff; code += 1) {
    assert.strictEqual(isSpace(code), /\s/.test(String.fromCharCode(code)), `U+${code.toString(16)}`);
  }
});

test('image data scanning matches the regular expressions it replaces', () => {
  const pieces = [
    'data:image/', 'DATA:IMAGE/', 'Data:Image/png;BASE64,', 'data:image/png;base64,', 'png', 'PNG;base64,',
    ';base64,', ';', '-.+', ' ', '  ', '\n', '\t', ' ', ' ', '　', 'A', 'Ab9+/=', 'x'.repeat(10),
    'A'.repeat(39), 'A'.repeat(40), 'B'.repeat(120), ')', '!', 'é', 'ſ', 'K'
  ];
  let seed = 1;
  const random = (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
  for (let run = 0; run < 20000; run += 1) {
    let text = '';
    for (let count = 1 + random(25); count > 0; count -= 1) text += pieces[random(pieces.length)];
    assert.strictEqual(hideCompleteImageData(text, '#'), completeRegex(text), JSON.stringify(text));
    assert.strictEqual(hidePartialImageData(text, '#'), partialRegex(text), JSON.stringify(text));
  }
});
