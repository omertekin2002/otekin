'use strict';

const assert = require('assert');
const profile = require('../lib/profile');

test('profile module pins the shared wording and links', () => {
  assert.deepStrictEqual(Object.keys(profile).sort(), ['greeting', 'links', 'name', 'tagline']);
  assert.strictEqual(profile.name, 'Ömer Tekin');
  assert.strictEqual(profile.greeting, "Hi, I'm Ömer Tekin.");
  assert.strictEqual(profile.tagline, 'Law & business student at Koç University.');
  assert.deepStrictEqual(profile.links, {
    website: 'https://omertekin2002.github.io',
    linkedin: 'https://www.linkedin.com/in/ömer-tekin/',
    cv: 'https://omertekin2002.github.io/resume'
  });
});
