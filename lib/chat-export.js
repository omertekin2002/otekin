'use strict';

const fs = require('fs');
const path = require('path');
const { cleanText } = require('./terminal');

// /save keeps only what was said: notices, errors and tool lines are left out.
const MAX_NAME_ATTEMPTS = 100;

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

// The conversation as a Markdown document, or null when there is nothing to save.
function transcriptMarkdown(messages, options) {
  const opts = options || {};
  const date = opts.date || new Date();
  const sections = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => {
      const speaker = message.role === 'user' ? 'You' : plainMarkdown(message.model).replace(/\s+/g, ' ') || 'OTEKIN';
      const content = plainMarkdown(typeof message.markdown === 'string' ? message.markdown : message.content);
      return `## ${speaker}\n\n${content}`;
    });
  if (!sections.length) return null;
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `# otekin chat · ${day} ${time}\n\n${sections.join('\n\n')}\n`;
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

module.exports = { transcriptMarkdown, saveTranscript };
