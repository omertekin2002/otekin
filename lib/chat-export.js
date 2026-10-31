'use strict';

const fs = require('fs');
const path = require('path');
const { cleanText } = require('./terminal');

// /save keeps only what was said: notices, errors and tool lines are left out.
const MAX_NAME_ATTEMPTS = 100;
// Longer than any ISO-8601 time, including six-digit years.
const MAX_ANSWERED_AT_CHARACTERS = 64;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Source URLs are already normalized, so only parentheses could end the link early.
function markdownLink(label, url) {
  const text = label.replace(/[\\[\]]/g, '\\$&');
  return `[${text}](${url.replace(/[()]/g, (char) => (char === '(' ? '%28' : '%29'))})`;
}

// Clickable source labels become Markdown links; every other escape is removed.
function plainMarkdown(value) {
  return cleanText(String(value == null ? '' : value)
    .replace(/\u001B\]8;;(https?:\/\/[^\u0000-\u001F\u007F]+)\u0007([^\u0000-\u001F\u007F]*?)\u001B\]8;;\u0007/gi,
      (link, url, label) => markdownLink(cleanText(label), url)))
    .replace(/\t/g, '  ')
    .replace(/\s+$/, '');
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function timestamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function calendarDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A reply's answer time as a Date, or null when it has none or it can't be read.
function answerDate(value) {
  if (typeof value !== 'string' || value.length > MAX_ANSWERED_AT_CHARACTERS) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

// The answer time shown after a reply's model label, in local time:
// "14:15" today, "30 Oct 14:15" on an earlier day, "30 Oct 2025 14:15" in another year.
function answerTimeLabel(value, now) {
  const date = answerDate(value);
  if (!date) return '';
  const today = new Date(now === undefined ? Date.now() : now);
  if (calendarDay(date) === calendarDay(today)) return clock(date);
  const year = date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year} ${clock(date)}`;
}

// The conversation as a Markdown document, or null when there is nothing to save.
function transcriptMarkdown(messages, options) {
  const opts = options || {};
  const date = opts.date || new Date();
  const sections = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => {
      const speaker = message.role === 'user' ? 'You' : plainMarkdown(message.model).replace(/\s+/g, ' ') || 'OTEKIN';
      const content = plainMarkdown(typeof message.markdown === 'string' ? message.markdown : message.content);
      const answered = message.role === 'assistant' && answerDate(message.answeredAt);
      return `## ${speaker}${answered ? ` · ${calendarDay(answered)} ${clock(answered)}` : ''}\n\n${content}`;
    });
  if (!sections.length) return null;
  return `# otekin chat · ${calendarDay(date)} ${clock(date)}\n\n${sections.join('\n\n')}\n`;
}

// Writes a new file and returns its path. Existing files are never replaced.
function saveTranscript(directory, messages, options) {
  const opts = options || {};
  const text = transcriptMarkdown(messages, opts);
  if (text === null) return null;
  const base = `otekin-chat-${timestamp(opts.date || new Date())}`;
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const file = path.join(directory, `${base}${attempt > 1 ? `-${attempt}` : ''}.md`);
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      fs.writeFileSync(fd, text);
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      throw error;
    }
    fs.closeSync(fd);
    return file;
  }
  throw Object.assign(new Error('Too many saved chats with the same name.'), { code: 'EEXIST' });
}

module.exports = { MAX_ANSWERED_AT_CHARACTERS, answerDate, answerTimeLabel, transcriptMarkdown, saveTranscript };
