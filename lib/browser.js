'use strict';

const path = require('path');
const { safeHttpUrl } = require('./chat-format');

// The URL a launcher may receive: a valid http(s) URL, normalised once by the URL parser so that
// `ö` becomes `%C3%B6` while an existing `%C3%B6` stays as it is. Anything else gives null.
function openableUrl(url) {
  const href = safeHttpUrl(url);
  // A normalised href never contains whitespace or `"`. Refuse one that does anyway: Windows would
  // quote that argument, and the URL must reach the launcher as exactly the text checked here.
  if (!href || /[\s"]/.test(href)) return null;
  return href;
}

// Pure so each platform's command can be tested anywhere. Returns null when the URL must not be
// opened (not http or https, or malformed).
function browserCommand(platform, url, env = process.env) {
  const href = openableUrl(url);
  if (!href) return null;
  if (platform === 'darwin') return { command: 'open', args: [href] };
  if (platform === 'win32') {
    // No cmd.exe: `cmd /c start` would read `&`, `|`, `^`, `%` and others in the URL as shell syntax,
    // so a link could run a command. rundll32 hands the URL to the default browser as one plain
    // argument. The absolute path keeps a rundll32.exe in the current directory from running instead.
    const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
    return {
      command: path.win32.join(systemRoot, 'System32', 'rundll32.exe'),
      args: ['url.dll,FileProtocolHandler', href]
    };
  }
  return { command: 'xdg-open', args: [href] };
}

module.exports = { browserCommand };
