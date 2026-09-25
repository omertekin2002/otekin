'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Normal terminal output links to local files; --json keeps the gateway payload untouched.
function saveGeneratedImages(response, options) {
  let directory;
  let count = 0;
  const message = response.message.replace(
    /!\[[^\]]*\]\(data:image\/png;base64,([A-Za-z0-9+/]+={0,2})\)/g,
    (_match, base64) => {
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

module.exports = { saveGeneratedImages };
