'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isBase64, replaceMarkdownImages } = require('./image-data');

const PNG_PREFIX = 'data:image/png;base64,';

// Like /data:image\/png;base64,([A-Za-z0-9+/]+={0,2})\)/ at `index`: the image's base64 and end.
function pngTarget(text, index) {
  if (!text.startsWith(PNG_PREFIX, index)) return null;
  const dataStart = index + PNG_PREFIX.length;
  let end = dataStart;
  while (end < text.length && text.charCodeAt(end) !== 0x3d && isBase64(text.charCodeAt(end))) end += 1;
  if (end === dataStart) return null;
  for (let padding = 0; padding < 2 && text.charCodeAt(end) === 0x3d; padding += 1) end += 1;
  return text.charCodeAt(end) === 0x29 ? { end: end + 1, base64: text.slice(dataStart, end) } : null;
}

// Replaces each Markdown PNG image with `replace(base64)`, like replacing
// /!\[[^\]]*\]\(data:image\/png;base64,([A-Za-z0-9+/]+={0,2})\)/g, but in linear time.
function replaceGeneratedPngs(text, replace) {
  return replaceMarkdownImages(text, false, pngTarget, (_alt, match) => replace(match.base64));
}

// Normal terminal output links to local files; --json keeps the gateway payload untouched.
function saveGeneratedImages(response, options) {
  let directory;
  let count = 0;
  const message = replaceGeneratedPngs(response.message,
    (base64) => {
      if (base64.length > 8 * 1024 * 1024 || count >= 2) return '[Generated image omitted: size limit]';
      try {
        directory = directory || fs.mkdtempSync(path.join((options && options.directory) || os.tmpdir(), 'otekin-images-'));
        const filename = path.join(directory, `image-${++count}.png`);
        fs.writeFileSync(filename, Buffer.from(base64, 'base64'), { flag: 'wx', mode: 0o600 });
        return `[Generated image saved to ${filename}]`;
      } catch {
        return '[Generated image could not be saved; use --json to retrieve the image data]';
      }
    }
  );
  return Object.assign({}, response, { message });
}

module.exports = { replaceGeneratedPngs, saveGeneratedImages };
