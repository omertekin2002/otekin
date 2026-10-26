'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareRequestMessages, MAX_MESSAGE_CHARACTERS } = require('./chat-client');
const { cleanText } = require('./terminal');

// The full-screen chat's conversation, saved as one JSON file between sessions.
const VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 100;
const MAX_PROMPTS = 50;
const ROLES = new Set(['user', 'assistant', 'tools', 'notice', 'error']);

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

// The file is untrusted: anything that isn't exactly the saved shape is rejected whole.
function parseHistory(text) {
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
    history = data.history.length ? prepareRequestMessages(data.history, '.').slice(0, -1) : [];
  } catch {
    return null;
  }
  const messages = data.messages.slice(-MAX_MESSAGES).map((item) => {
    const message = { role: item.role, content: cleanText(item.content) };
    // A label that needed cleaning is dropped; the app shows its default instead.
    if (item.role === 'assistant') message.model = item.model === cleanText(item.model) ? item.model : '';
    return message;
  });
  const prompts = data.prompts.slice(-MAX_PROMPTS)
    .map((prompt) => cleanText(prompt).replace(/\t/g, '  ').trim())
    .filter((prompt) => prompt && prompt.length <= MAX_MESSAGE_CHARACTERS);
  return { history, messages, prompts };
}

// Returns the saved conversation, or null when there is none or it can't be used.
function loadHistory(file) {
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) return null;
    const restored = parseHistory(text);
    if (!restored || (!restored.history.length && !restored.messages.length && !restored.prompts.length)) {
      return null;
    }
    return restored;
  } catch {
    return null;
  }
}

function serializeHistory(state) {
  const data = {
    version: VERSION,
    history: Array.isArray(state.history) ? state.history : [],
    messages: (Array.isArray(state.messages) ? state.messages : []).slice(-MAX_MESSAGES).map((message) => {
      const saved = { role: message.role, content: cleanText(message.content) };
      if (message.role === 'assistant' && typeof message.model === 'string') saved.model = message.model;
      return saved;
    }),
    prompts: (Array.isArray(state.prompts) ? state.prompts : []).slice(-MAX_PROMPTS)
  };
  let text = JSON.stringify(data);
  // Drop the oldest transcript entries, then prompts, until the file can be loaded again.
  while (Buffer.byteLength(text) > MAX_FILE_BYTES && (data.messages.length || data.prompts.length)) {
    if (data.messages.length) data.messages.shift();
    else data.prompts.shift();
    text = JSON.stringify(data);
  }
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Chat history is too large to save.');
  return text;
}

// Owner-only permissions, written to a temp file and renamed so a crash never leaves half a file.
function saveHistory(file, state) {
  const text = serializeHistory(state);
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
}

function clearHistory(file) {
  fs.rmSync(file, { force: true });
}

module.exports = {
  VERSION,
  MAX_FILE_BYTES,
  MAX_MESSAGES,
  MAX_PROMPTS,
  resolveHistoryFile,
  historyFileFor,
  parseHistory,
  loadHistory,
  serializeHistory,
  saveHistory,
  clearHistory
};
