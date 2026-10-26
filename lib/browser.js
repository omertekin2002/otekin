'use strict';

function safeEncodeUrl(url) {
  try {
    return encodeURI(url);
  } catch {
    return url;
  }
}

// Pure so each platform's command can be tested anywhere. The empty argument
// after `start` is the window title; without it a quoted URL would become the title.
function browserCommand(platform, url) {
  const encoded = safeEncodeUrl(url);
  if (platform === 'darwin') return { command: 'open', args: [encoded] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', encoded] };
  return { command: 'xdg-open', args: [encoded] };
}

module.exports = { browserCommand };
