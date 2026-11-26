'use strict';

const readline = require('readline');

// Removes OSC sequences like replacing /(?:\u001B\]|\u009D)[^\u0007\u001B]*(?:\u0007|\u001B\\)/g, in
// linear time. That expression rescans the rest of the text from every unterminated \u009D.
// Every introducer before the same BEL or ESC ends there, so each terminator is found only once.
function stripOsc(text) {
  const parts = [];
  let copied = 0;
  let terminator = -1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    let bodyStart;
    if (code === 0x9d) bodyStart = index + 1;
    else if (code === 0x1b && text.charCodeAt(index + 1) === 0x5d) bodyStart = index + 2;
    else continue;
    if (terminator < bodyStart) {
      terminator = bodyStart;
      while (terminator < text.length) {
        const next = text.charCodeAt(terminator);
        if (next === 0x07 || next === 0x1b) break;
        terminator += 1;
      }
      // No BEL or ESC is left, so no later introducer can end either.
      if (terminator === text.length) break;
    }
    let end;
    if (text.charCodeAt(terminator) === 0x07) end = terminator + 1;
    else if (text.charCodeAt(terminator + 1) === 0x5c) end = terminator + 2;
    else continue;
    parts.push(text.slice(copied, index));
    copied = end;
    index = end - 1;
  }
  if (!parts.length) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

// Invisible format characters that remote text can use to disguise itself: the bidi
// embeddings and overrides (U+202A-U+202E) and isolates (U+2066-U+2069), which reorder the
// text after them and, left open, the rest of the line, plus the zero-width space (U+200B),
// the word joiner and invisible operators (U+2060-U+2064) and the BOM (U+FEFF).
// ZWNJ and ZWJ (U+200C, U+200D), which emoji and many scripts need, stay, and so do the
// LRM, RLM and ALM marks (U+200E, U+200F, U+061C), which cannot reorder beyond their neighbours.
const INVISIBLE_FORMAT_CHARACTERS = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function removeInvisibleFormatting(text) {
  return text.replace(INVISIBLE_FORMAT_CHARACTERS, '');
}

// Text from the gateway or from disk, made safe to print: no terminal escapes, no control
// characters other than tab and line feed, and none of the invisible format characters above.
// Every step is a single linear scan.
function cleanText(value) {
  return removeInvisibleFormatting(stripOsc(String(value == null ? '' : value))
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, ''));
}

// A gateway request ID is shown only when it looks like one, so a header can't smuggle in text.
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A gateway request ID that is safe to show, or null when it is missing or doesn't look like one.
 * @param {unknown} value
 * @returns {string | null}
 */
function safeRequestId(value) {
  const requestId = typeof value === 'string' ? value.trim() : '';
  return REQUEST_ID.test(requestId) ? requestId : null;
}
// What a failure at each stage of a chat request means for the question.
// `readiness`: the GET /healthz wake-up check, which runs before any conversation content is sent.
// `request`: the chat POST itself; the gateway may have started on the question before it failed.
// A chat POST that never connected sent nothing either, so it reads as `readiness` (see chatFailureStage).
const CHAT_FAILURE_STAGES = {
  readiness: 'Your question was not sent.',
  request: 'The chat service may have received your question.'
};
// How the person can send the question again: by typing /retry, or, where the full-screen chat put
// the question back in its empty composer, by pressing Enter.
const RETRY_HINTS = {
  retry: 'Type /retry to send it again.',
  composer: 'Your question is back in the composer. Press Enter to send it again.'
};

/**
 * The stage whose note truthfully describes a failure. A chat request whose error says it was
 * certainly not sent (`notSent`: a rejected URL, or no connection before it failed or timed out)
 * reads as a readiness failure; every other request failure may have reached the gateway.
 * @template {'readiness' | 'request' | null | undefined} S
 * @param {unknown} error
 * @param {S} stage
 * @returns {S | 'readiness'}
 */
function chatFailureStage(error, stage) {
  const failure = /** @type {{ notSent?: unknown } | null | undefined} */ (error);
  return stage === 'request' && failure && failure.notSent === true ? 'readiness' : stage;
}

/**
 * The one safe way to describe a chat failure: the error's cleaned category text and a
 * well-formed request ID, never a provider's raw error. With a stage it also says whether the
 * question was sent, and with `retryHint` (only where a person can type /retry) how to resend it:
 * `true` points to /retry, and `'composer'` says the question is back in the composer.
 * @param {unknown} error
 * @param {'readiness' | 'request' | null} [stage]
 * @param {{ retryHint?: boolean | 'composer' }} [options]
 * @returns {string}
 */
function chatErrorMessage(error, stage, options) {
  const failure = /** @type {{ message?: unknown, requestId?: unknown } | null | undefined} */ (error);
  const note = stage ? CHAT_FAILURE_STAGES[stage] : undefined;
  let message = failure && failure.message ? cleanText(failure.message) : 'Chat request failed.';
  // Every client message is a sentence, but a note after one that isn't still reads as its own.
  if (note && !/[.!?]$/.test(message)) message += '.';
  const requestId = safeRequestId(failure && failure.requestId);
  const parts = [requestId ? `${message} (Request ID: ${requestId})` : message];
  if (note) {
    parts.push(note);
    const hint = options && options.retryHint;
    if (hint) parts.push(hint === 'composer' ? RETRY_HINTS.composer : RETRY_HINTS.retry);
  }
  return parts.join(' ');
}

// DEL, the C1 controls (U+0080-U+009F: U+009B is CSI and U+009D is OSC on terminals that
// honour 8-bit controls) and the bidi marks, embeddings, overrides and isolates.
// JSON.stringify escapes only U+0000-U+001F and writes these raw.
const JSON_UNSAFE = /[\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// The same characters, each mapped to its \uXXXX escape.
/** @type {Record<string, string>} */
const JSON_ESCAPES = {};
for (const [first, last] of [[0x7f, 0x9f], [0x61c, 0x61c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]]) {
  for (let code = first; code <= last; code += 1) {
    JSON_ESCAPES[String.fromCharCode(code)] = '\\u' + code.toString(16).padStart(4, '0');
  }
}

// JSON.stringify(value, null, 2), with every character above written as its escape, so
// printed JSON cannot drive the terminal or reorder itself. It parses to the same value,
// and output without those characters is unchanged. They can only occur inside strings,
// because everything JSON.stringify writes outside them is ASCII.
function stringifyJsonForOutput(value) {
  return JSON.stringify(value, null, 2).replace(JSON_UNSAFE, (char) => JSON_ESCAPES[char]);
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

const PROGRESS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Shown instead of a spinner frame when motion is reduced; it never changes.
const STATIC_MARKER = '…';

// --reduced-motion, or OTEKIN_REDUCED_MOTION set to anything but empty, 0, false, no or off.
function reducedMotionFor(options, env) {
  const value = (env || process.env).OTEKIN_REDUCED_MOTION;
  return Boolean(options && options.reducedMotion) ||
    (typeof value === 'string' && value.trim() !== '' && !/^(?:0|false|no|off)$/i.test(value.trim()));
}

// With `reducedMotion`, the line shows a static marker and no elapsed seconds, and it is
// redrawn only when its text changes, such as a new label or a resize.
function startProgress(stream, message, options) {
  const opts = options || {};
  const theme = createTheme(stream);
  if (!theme.interactive) return () => {};
  const started = opts.startedAt || Date.now();
  const reduced = Boolean(opts.reducedMotion);
  let frame = 0;
  let stopped = false;
  let drawn = null;
  let interval;
  const render = () => {
    const label = typeof message === 'function' ? message() : message;
    const width = Math.max(1, (stream.columns || 80) - 3);
    const text = reduced ? `${STATIC_MARKER} ${label}`
      : `${PROGRESS_FRAMES[frame++ % PROGRESS_FRAMES.length]} ${label} · ${Math.floor((Date.now() - started) / 1000)}s`;
    const line = clipLine(text, width);
    if (reduced && line === drawn) return;
    readline.cursorTo(stream, 0);
    readline.clearLine(stream, 0);
    stream.write('  ' + theme.muted(line));
    drawn = line;
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
    if (drawn !== null) {
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

function createActivityDisplay(stream, options) {
  const theme = createTheme(stream);
  const reducedMotion = Boolean(options && options.reducedMotion);
  const activities = new Map();
  const startedAt = Date.now();
  let stopped = false;
  let paused = false;
  const runningLabel = () => {
    const running = [...activities.values()].filter((activity) => activity.status === 'running');
    return running.length ? activityLabel(running[running.length - 1], true) +
      (running.length > 1 ? ` (+${running.length - 1} active)` : '') : null;
  };
  const currentLabel = () => runningLabel() || 'Thinking';
  let clear = startProgress(stream, currentLabel, { startedAt, reducedMotion });

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
    if (!paused) clear = startProgress(stream, currentLabel, { startedAt, reducedMotion });
  };

  return {
    onActivity,
    runningLabel,
    startedAt,
    // Hides the status line while another view, such as a stream preview, shows status.
    pause() {
      if (paused || stopped) return;
      paused = true;
      clear();
      clear = () => {};
    },
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

module.exports = {
  PROGRESS_FRAMES,
  STATIC_MARKER,
  reducedMotionFor,
  cleanText,
  chatErrorMessage,
  chatFailureStage,
  safeRequestId,
  removeInvisibleFormatting,
  stringifyJsonForOutput,
  createTheme,
  clipLine,
  startProgress,
  activityLabel,
  createActivityDisplay
};
