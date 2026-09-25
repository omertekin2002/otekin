'use strict';

const readline = require('readline');

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/(?:\u001B\]|\u009D)[^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

function createTheme(stream, env) {
  const environment = env || process.env;
  const interactive = Boolean(stream.isTTY && environment.TERM !== 'dumb');
  const color = interactive && !Object.prototype.hasOwnProperty.call(environment, 'NO_COLOR');
  const style = (code) => (text) => color ? `\u001B[${code}m${text}\u001B[0m` : String(text);
  return {
    interactive,
    color,
    muted: style('2'),
    accent: style('36'),
    strong: style('1'),
    warning: style('33')
  };
}

// Keep animated rows on one terminal line, including queries in wide scripts.
function clipLine(value, columns) {
  const text = cleanText(value).replace(/[\r\n\t]/g, ' ').trimEnd();
  const limit = Math.max(1, columns);
  const characters = Array.from(text);
  let width = 0;
  let result = '';
  for (let index = 0; index < characters.length; index += 1) {
    const char = characters[index];
    const code = char.codePointAt(0);
    const size = /\p{Mark}/u.test(char) || code === 0x200d ? 0 :
      (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
        (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
        code >= 0x1f000)) ? 2 : 1;
    if ((width + size > limit - 1 && index < characters.length - 1) || width + size > limit) {
      return result + '…';
    }
    result += char;
    width += size;
  }
  return result;
}

function startProgress(stream, message, options) {
  const opts = options || {};
  const theme = createTheme(stream);
  if (!theme.interactive) return () => {};
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const started = opts.startedAt || Date.now();
  let frame = 0;
  let stopped = false;
  let drawn = false;
  let interval;
  const render = () => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const label = typeof message === 'function' ? message() : message;
    const line = clipLine(`${frames[frame++ % frames.length]} ${label} · ${elapsed}s`,
      Math.max(1, (stream.columns || 80) - 3));
    readline.cursorTo(stream, 0);
    readline.clearLine(stream, 0);
    stream.write('  ' + theme.muted(line));
    drawn = true;
  };
  const delay = setTimeout(() => {
    render();
    interval = setInterval(render, 100);
    interval.unref();
  }, opts.delayMs || 0);
  delay.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(delay);
    clearInterval(interval);
    if (drawn) {
      readline.cursorTo(stream, 0);
      readline.clearLine(stream, 0);
    }
  };
}

function activityLabel(activity, running) {
  const labels = {
    search_web: ['Search', 'Searching'],
    read_url: ['Read page', 'Reading page'],
    http_get: ['Fetch data', 'Fetching data'],
    generate_image: ['Create image', 'Creating image']
  };
  const label = (labels[activity.tool || 'search_web'] || ['Tool', 'Using tool'])[running ? 1 : 0];
  const query = cleanText(activity.query).replace(/\s+/g, ' ').trim();
  return `${label}${query ? `  ${query}` : ''}`;
}

function createActivityDisplay(stream) {
  const theme = createTheme(stream);
  const activities = new Map();
  const startedAt = Date.now();
  let stopped = false;
  const currentLabel = () => {
    const running = [...activities.values()].filter((activity) => activity.status === 'running');
    return running.length ? activityLabel(running[running.length - 1], true) +
      (running.length > 1 ? ` (+${running.length - 1} active)` : '') : 'Thinking';
  };
  let clear = startProgress(stream, currentLabel, { startedAt });

  const onActivity = (activity) => {
    if (stopped || !activity || typeof activity.id !== 'string' ||
        typeof activity.query !== 'string' ||
        !['running', 'complete', 'error'].includes(activity.status)) return;
    const previous = activities.get(activity.id);
    if (previous && previous.status !== 'running') return;
    if (!previous && activities.size >= 64) return;
    activities.set(activity.id, activity);
    if (activity.status === 'running') return;
    clear();
    const failed = activity.status === 'error';
    const line = clipLine(`${failed ? '!' : '✓'} ${activityLabel(activity, false)}${failed ? ' (failed)' : ''}`,
      Math.max(1, (stream.columns || 80) - 3));
    stream.write('  ' + theme.muted(line) + '\n');
    clear = startProgress(stream, currentLabel, { startedAt });
  };

  return {
    onActivity,
    finish(response) {
      // A JSON-only gateway can still provide the completed activity catalog.
      if (response && Array.isArray(response.toolActivity)) response.toolActivity.forEach(onActivity);
      this.stop();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clear();
    }
  };
}

module.exports = { cleanText, createTheme, clipLine, startProgress, createActivityDisplay };
