'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareRequestMessages, MAX_MESSAGE_CHARACTERS } = require('./chat-client');
const { answerDate } = require('./chat-export');
const { isPlainTitle, safeHttpUrl } = require('./chat-format');
const { cleanText, removeInvisibleFormatting } = require('./terminal');

// The full-screen chat's conversation, saved as one JSON file between sessions.
const VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 100;
const MAX_PROMPTS = 50;
const ROLES = new Set(['user', 'assistant', 'tools', 'notice', 'error']);
// Bounds for the sources saved with a transcript reply, so its links can be rebuilt.
const MAX_SOURCES = 100;
const MAX_SOURCE_TITLE_CHARACTERS = 256;
const MAX_SOURCE_URL_CHARACTERS = 2048;
// The longest Markdown kept for a reply without sources; a longer one is saved as plain text.
// Replies are not cut to the request limit (MAX_MESSAGE_CHARACTERS), so this bound is larger.
const MAX_ANSWER_CHARACTERS = 100000;
// A reply's answer time is kept only between these bounds; a day ahead allows for clock changes.
const EARLIEST_ANSWER_TIME = Date.UTC(2020, 0, 1);
const MAX_ANSWER_TIME_AHEAD = 24 * 60 * 60 * 1000;
// Shown once, by either chat, when it stops saving because another chat changed the file.
// Short enough for the full-screen status line at 80 columns.
const HISTORY_CHANGED_NOTICE = 'Another chat changed saved history; this one stopped saving. /save works.';
// How a session remembers that there was no history file when it last looked.
const ABSENT = 'absent';

function isEnabled(value) {
  return typeof value === 'string' && value !== '' && !/^(?:0|false|no|off)$/i.test(value.trim());
}

function resolveHistoryFile(env, platform, homedir) {
  const environment = env || process.env;
  const system = platform || process.platform;
  const paths = system === 'win32' ? path.win32 : path.posix;
  if (environment.OTEKIN_HISTORY_FILE) return paths.resolve(environment.OTEKIN_HISTORY_FILE);
  let home = homedir;
  if (home === undefined) {
    try {
      home = os.homedir();
    } catch {
      home = '';
    }
  }
  if (system === 'win32') {
    const base = paths.isAbsolute(environment.LOCALAPPDATA || '') ? environment.LOCALAPPDATA
      : home && paths.join(home, 'AppData', 'Local');
    return base ? paths.join(base, 'otekin', 'history.json') : null;
  }
  if (system === 'darwin') {
    return home ? paths.join(home, 'Library', 'Application Support', 'otekin', 'history.json') : null;
  }
  // The XDG spec says to ignore relative paths.
  const state = paths.isAbsolute(environment.XDG_STATE_HOME || '') ? environment.XDG_STATE_HOME
    : home && paths.join(home, '.local', 'state');
  return state ? paths.join(state, 'otekin', 'history.json') : null;
}

// The file to use for this run, or null when history is turned off.
function historyFileFor(options, env, platform, homedir) {
  const environment = env || process.env;
  if ((options && options.noHistory) || isEnabled(environment.OTEKIN_NO_HISTORY)) return null;
  return resolveHistoryFile(environment, platform, homedir);
}

// A request replays only the newest source catalog, but the app also keeps the one before it,
// so a /retry that replaces the last turn still sends the earlier turns' sources.
function withPreviousCatalog(history, saved) {
  const [user, assistant] = saved.slice(-2);
  if (!history.length || !history[history.length - 1].webSources ||
      !user || user.role !== 'user' || !assistant || assistant.role !== 'assistant') return history;
  const earlier = prepareRequestMessages(saved.slice(0, -2), '.').slice(0, -1);
  const index = earlier.findLastIndex((message) => message.webSources);
  if (index < 0) return history;
  // Both lists are trimmed from the front, so they line up from the end.
  const target = history.length - 2 - (earlier.length - index);
  if (target < 0 || history[target].role !== 'assistant' || history[target].content !== earlier[index].content) {
    return history;
  }
  return history.map((message, position) =>
    position === target ? { ...message, webSources: earlier[index].webSources } : message);
}

// A reply's usable sources as [{number, title, url}], or null when none are left.
// Each entry keeps its own number, so dropping a bad one never shifts the answer's citations.
// Titles are single-line text with nothing for cleanText to remove: the invisible format
// characters it removes are removed from a title saved by an older version, keeping the
// source. A source without a link has no url; every link is an absolute http(s) URL.
function validSources(sources) {
  if (!Array.isArray(sources)) return null;
  const numbers = new Set();
  const valid = [];
  for (const source of sources.slice(0, MAX_SOURCES)) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const { number, url } = source;
    if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number)) continue;
    if (!isPlainTitle(source.title) || source.title.length > MAX_SOURCE_TITLE_CHARACTERS) continue;
    const title = removeInvisibleFormatting(source.title);
    if (url === undefined || url === null) {
      numbers.add(number);
      valid.push({ number, title, url: null });
      continue;
    }
    if (typeof url !== 'string' || url.length > MAX_SOURCE_URL_CHARACTERS ||
        /[\s\u0000-\u001F\u007F-\u009F]/.test(url) || safeHttpUrl(url) !== url) continue;
    numbers.add(number);
    valid.push({ number, title, url });
  }
  return valid.length ? valid : null;
}

// The answer text and sources a reply was rendered from, when both are usable.
function replySources(item) {
  if (typeof item.answer !== 'string') return null;
  const sources = validSources(item.sources);
  return sources && { answer: cleanText(item.answer), sources };
}

// The Markdown a reply without sources was rendered from, or null when it has none or it is
// unusable. A reply with sources, even unusable ones, gets none here: it is kept as replySources
// keeps it, or as plain text. Older versions ignore an answer without sources.
function replyMarkdown(item, markdown) {
  if (item.sources !== undefined && !(Array.isArray(item.sources) && item.sources.length === 0)) return null;
  if (typeof markdown !== 'string') return null;
  const answer = cleanText(markdown);
  return answer.length <= MAX_ANSWER_CHARACTERS ? answer : null;
}

// A reply's answer time as an ISO-8601 UTC string, or null when it is missing or unusable.
function validAnsweredAt(value, now) {
  const date = answerDate(value);
  if (!date) return null;
  const time = date.getTime();
  return time >= EARLIEST_ANSWER_TIME && time <= now + MAX_ANSWER_TIME_AHEAD ? date.toISOString() : null;
}

// The file is untrusted: anything that isn't exactly the saved shape is rejected whole.
// The optional answer and sources on a reply are dropped alone, leaving it as plain text,
// and so is its answer time. A reply without sources may have an answer alone: its Markdown.
function parseHistory(text, now = Date.now()) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || data.version !== VERSION ||
      !Array.isArray(data.history) || !Array.isArray(data.messages) || !Array.isArray(data.prompts)) {
    return null;
  }
  if (!data.history.every((item) => item && typeof item === 'object' &&
      (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')) {
    return null;
  }
  if (!data.messages.every((item) => item && typeof item === 'object' && ROLES.has(item.role) &&
      typeof item.content === 'string' && (item.model === undefined || typeof item.model === 'string'))) {
    return null;
  }
  if (!data.prompts.every((item) => typeof item === 'string')) return null;

  let history;
  try {
    // The same validation and bounds as a new request, without the new prompt.
    history = data.history.length
      ? withPreviousCatalog(prepareRequestMessages(data.history, '.').slice(0, -1), data.history) : [];
  } catch {
    return null;
  }
  const messages = data.messages.slice(-MAX_MESSAGES).map((item) => {
    const message = { role: item.role, content: cleanText(item.content) };
    // A label that needed cleaning is dropped; the app shows its default instead.
    if (item.role === 'assistant') {
      message.model = item.model === cleanText(item.model) ? item.model : '';
      const reply = replySources(item);
      if (reply) Object.assign(message, reply);
      else if (item.sources === undefined) {
        const answer = replyMarkdown(item, item.answer);
        if (answer !== null) message.answer = answer;
      }
      const answeredAt = validAnsweredAt(item.answeredAt, now);
      if (answeredAt) message.answeredAt = answeredAt;
    }
    return message;
  });
  const prompts = data.prompts.slice(-MAX_PROMPTS)
    .map((prompt) => cleanText(prompt).replace(/\t/g, '  ').trim())
    .filter((prompt) => prompt && prompt.length <= MAX_MESSAGE_CHARACTERS);
  return { history, messages, prompts };
}

// What the history file looks like right now, without parsing it: 'absent' when there is none,
// otherwise a SHA-256 of its bytes. A file too large to load, or one that can't be read, gets a
// cheaper description instead, which still changes when another session replaces it.
function readHistoryFile(file) {
  let stats;
  try {
    stats = fs.statSync(file);
  } catch (error) {
    return { fingerprint: error && error.code === 'ENOENT' ? ABSENT : `error:${error && error.code}`, text: null };
  }
  const described = `other:${stats.isFile() ? 'file' : 'not-file'}:${stats.size}:${stats.mtimeMs}`;
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return { fingerprint: described, text: null };
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    return { fingerprint: error && error.code === 'ENOENT' ? ABSENT : `error:${error && error.code}`, text: null };
  }
  // The file can grow between the stat and the read.
  if (bytes.length > MAX_FILE_BYTES) return { fingerprint: described, text: null };
  return { fingerprint: fingerprintOf(bytes), text: bytes.toString('utf8') };
}

function fingerprintOf(bytes) {
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

// Returns the saved conversation, or null when there is none or it can't be used.
// A session passes its `snapshot` so the save after its next reply can tell whether another
// session changed the file in between: see saveHistory.
function loadHistory(file, snapshot) {
  try {
    const { fingerprint, text } = readHistoryFile(file);
    if (snapshot) snapshot.fingerprint = fingerprint;
    if (text === null || Buffer.byteLength(text) > MAX_FILE_BYTES) return null;
    const restored = parseHistory(text);
    if (!restored || (!restored.history.length && !restored.messages.length && !restored.prompts.length)) {
      return null;
    }
    return restored;
  } catch {
    return null;
  }
}

function serializeHistory(state, now = Date.now()) {
  const data = {
    version: VERSION,
    history: Array.isArray(state.history) ? state.history : [],
    messages: (Array.isArray(state.messages) ? state.messages : []).slice(-MAX_MESSAGES).map((message) => {
      const saved = { role: message.role, content: cleanText(message.content) };
      if (message.role !== 'assistant') return saved;
      if (typeof message.model === 'string') saved.model = message.model;
      const reply = replySources(message);
      if (reply) {
        saved.answer = reply.answer;
        saved.sources = reply.sources.map(({ number, title, url }) => (url ? { number, title, url } : { number, title }));
      } else {
        // A reply without sources keeps its Markdown, which its styled content has lost.
        const answer = replyMarkdown(message, typeof message.answer === 'string' ? message.answer : message.markdown);
        if (answer !== null) saved.answer = answer;
      }
      const answeredAt = validAnsweredAt(message.answeredAt, now);
      if (answeredAt) saved.answeredAt = answeredAt;
      return saved;
    }),
    prompts: (Array.isArray(state.prompts) ? state.prompts : []).slice(-MAX_PROMPTS)
  };
  // Drop the oldest transcript entries, then prompts, until the file can be loaded again.
  // JSON.stringify writes an array as its elements' own JSON joined by commas, so the file's
  // size is the size of the envelope with both lists empty, plus each kept entry's size, plus
  // one comma between neighbours. Each entry is measured once, so finding what to drop is
  // linear rather than one stringify of the whole conversation per dropped entry.
  const messageSizes = data.messages.map(entrySize);
  const promptSizes = data.prompts.map(entrySize);
  let size = Buffer.byteLength(JSON.stringify({ ...data, messages: [], prompts: [] })) +
    listSize(messageSizes) + listSize(promptSizes);
  let messageStart = 0;
  let promptStart = 0;
  while (size > MAX_FILE_BYTES && (messageStart < messageSizes.length || promptStart < promptSizes.length)) {
    if (messageStart < messageSizes.length) {
      size -= messageSizes[messageStart] + (messageStart < messageSizes.length - 1 ? 1 : 0);
      messageStart++;
    } else {
      size -= promptSizes[promptStart] + (promptStart < promptSizes.length - 1 ? 1 : 0);
      promptStart++;
    }
  }
  data.messages = data.messages.slice(messageStart);
  data.prompts = data.prompts.slice(promptStart);
  const text = JSON.stringify(data);
  // The measured size is exact; checking the text itself keeps the cap even if it weren't.
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Chat history is too large to save.');
  return text;
}

// The UTF-8 bytes an entry takes inside a JSON array, as JSON.stringify writes it there
// (a value JSON can't hold, such as undefined, is written as null).
function entrySize(entry) {
  return Buffer.byteLength(JSON.stringify([entry])) - 2;
}

// The UTF-8 bytes a JSON array's elements take between its brackets.
function listSize(sizes) {
  return sizes.reduce((total, size) => total + size, 0) + Math.max(0, sizes.length - 1);
}

// Owner-only permissions, written to a temp file and renamed so a crash never leaves half a file.
// With a `snapshot` from loadHistory, the file is written only if it still looks the way this
// session last loaded or wrote it; otherwise another chat saved or /cleared it, and this returns
// false without writing, so one session never wipes another's conversation or brings back one
// that was cleared. Checking and renaming are separate steps, so two saves at the same instant
// can still race; there is no lock file. Returns true once written.
function saveHistory(file, state, snapshot) {
  const text = serializeHistory(state);
  if (snapshot && snapshot.fingerprint !== undefined && readHistoryFile(file).fingerprint !== snapshot.fingerprint) {
    return false;
  }
  const directory = path.dirname(file);
  if (fs.mkdirSync(directory, { recursive: true, mode: 0o700 }) && process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
  }
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  if (snapshot) snapshot.fingerprint = fingerprintOf(Buffer.from(text));
  return true;
}

// Deletes the file. A session's own /clear starts it over, so its next save writes a fresh file.
function clearHistory(file, snapshot) {
  fs.rmSync(file, { force: true });
  if (snapshot) snapshot.fingerprint = ABSENT;
}

module.exports = {
  VERSION,
  MAX_FILE_BYTES,
  MAX_MESSAGES,
  MAX_PROMPTS,
  MAX_SOURCES,
  MAX_SOURCE_TITLE_CHARACTERS,
  MAX_SOURCE_URL_CHARACTERS,
  MAX_ANSWER_CHARACTERS,
  resolveHistoryFile,
  historyFileFor,
  parseHistory,
  loadHistory,
  readHistoryFile,
  serializeHistory,
  saveHistory,
  clearHistory,
  HISTORY_CHANGED_NOTICE
};
