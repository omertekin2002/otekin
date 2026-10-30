'use strict';

const { cleanText, createTheme } = require('./terminal');

const MAX_SOURCE_TITLE_CHARACTERS = 48;
// C0 and C1 controls and DEL, including line breaks: a source title never contains any of them.
const TITLE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

// Whether a title is single-line text that could reach the terminal unchanged.
function isPlainTitle(value) {
  return typeof value === 'string' && value.search(TITLE_CONTROL_CHARACTERS) < 0;
}

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const title = value
    .replace(TITLE_CONTROL_CHARACTERS, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (title.length <= MAX_SOURCE_TITLE_CHARACTERS) return title;
  return title.slice(0, MAX_SOURCE_TITLE_CHARACTERS - 1).trimEnd() + '…';
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u001F\u007F]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function hostnameFor(value) {
  const url = safeHttpUrl(value);
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function splitSourceBlock(message) {
  const text = typeof message === 'string' ? message : '';
  const heading = /(^|\r?\n[ \t]*\r?\n)(?:#{1,6}[ \t]*)?sources:[ \t]*\r?\n(?=[ \t]*(?:\d+[.)]|[-*])[ \t]+)/gim;
  let match;
  let lastMatch = null;

  while ((match = heading.exec(text)) !== null) lastMatch = match;
  if (!lastMatch) return { answer: text, sourceBlock: '' };

  return {
    answer: text.slice(0, lastMatch.index),
    sourceBlock: text.slice(lastMatch.index + lastMatch[0].length)
  };
}

function isSourceNumber(number) {
  return Number.isSafeInteger(number) && number > 0;
}

function sourceNumber(source, index) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const number = 'number' in source ? source.number : index + 1;
  return isSourceNumber(number) ? number : null;
}

function parseSourceBlock(sourceBlock) {
  if (!sourceBlock) return [];

  const sources = [];
  for (const line of sourceBlock.split(/\r?\n/)) {
    const numbered = line.match(
      /^\s*[-*]\s+\[(\d+)\]\s+\[((?:\\.|[^\]])+)\]\(\s*<?(https?:\/\/[^>\s]+)>?\s*\)\s*$/i
    );
    if (numbered) {
      const number = Number(numbered[1]);
      if (isSourceNumber(number)) {
        sources.push({ number, title: numbered[2].replace(/\\(.)/g, '$1'), url: numbered[3].replace(/>$/, '') });
      }
      continue;
    }
    const markdown = line.match(
      /^\s*(?:\d+[.)]|[-*])\s+\[([^\]]+)\]\(\s*<?(https?:\/\/[^>\s)]+)>?\s*\)/i
    );
    if (markdown) {
      sources.push({ title: markdown[1], url: markdown[2] });
      continue;
    }

    const plain = line.match(/^\s*(?:\d+[.)]|[-*])\s+(https?:\/\/\S+)/i);
    if (plain) sources.push({ title: hostnameFor(plain[1]), url: plain[1] });
  }
  return sources;
}

function collectSources(response, parsedSources) {
  const structuredSources = Array.isArray(response && response.webSources)
    ? response.webSources
    : [];
  const sourcesByNumber = new Map();
  structuredSources.forEach((source, index) => {
    const number = sourceNumber(source, index);
    if (number === null) return;
    const previous = sourcesByNumber.get(number);
    // Explicit IDs take precedence over colliding legacy positions in either order.
    if (!previous || (!('number' in previous) && 'number' in source)) {
      sourcesByNumber.set(number, source);
    }
  });
  // New gateway footers identify the displayed subset of a cumulative source catalog.
  if (parsedSources.some((source) => isSourceNumber(source.number))) {
    const sources = [];
    const usedNumbers = new Set();
    for (let index = 0; index < parsedSources.length; index += 1) {
      const parsed = parsedSources[index];
      let number = sourceNumber(parsed, index);
      let structured = sourcesByNumber.get(number);
      if (!('number' in parsed)) {
        const parsedUrl = safeHttpUrl(parsed.url);
        const match = [...sourcesByNumber].find(([, source]) =>
          parsedUrl && safeHttpUrl(source.url) === parsedUrl);
        if (match) [number, structured] = match;
        // A position that is another source's stable ID would mislabel this link.
        else if (structured && 'number' in structured) return [];
      }
      // Keep the canonical footer when two entries would share one citation number.
      if (usedNumbers.has(number)) return [];
      usedNumbers.add(number);
      structured = structured || {};
      const url = safeHttpUrl(structured.url) || safeHttpUrl(parsed.url);
      sources.push({
        number,
        title: cleanTitle(structured.title) || cleanTitle(parsed.title) || hostnameFor(url),
        url
      });
    }
    return sources;
  }
  // With new metadata, an absent footer means no sources were used on this turn.
  if (Array.isArray(response && response.readSources) && parsedSources.length === 0) {
    return [];
  }
  const sources = [];
  const matchedFooterSources = new Set();
  const appendSource = (number, structured, parsed) => {
    const url = safeHttpUrl(structured.url) || safeHttpUrl(parsed.url);
    const title = cleanTitle(structured.title) ||
      cleanTitle(parsed.title) ||
      cleanTitle(hostnameFor(url)) ||
      `Source ${number}`;

    sources.push({ number, title, url });
  };

  for (let index = 0; index < structuredSources.length; index += 1) {
    const structured = structuredSources[index];
    const number = sourceNumber(structured, index);
    if (number === null || sourcesByNumber.get(number) !== structured) continue;
    // A legacy footer has no IDs: only a matching URL can fill explicit metadata.
    const parsed = ('number' in structured
      ? parsedSources.find((candidate) => !matchedFooterSources.has(candidate) &&
        safeHttpUrl(structured.url) && safeHttpUrl(candidate.url) === safeHttpUrl(structured.url))
      : (!matchedFooterSources.has(parsedSources[index]) && parsedSources[index])) || {};
    matchedFooterSources.add(parsed);
    appendSource(number, structured, parsed);
  }

  for (let index = 0; index < parsedSources.length; index += 1) {
    const parsed = parsedSources[index];
    if (matchedFooterSources.has(parsed)) continue;
    const number = index + 1;
    // Keep the canonical footer if its legacy position conflicts with another source's ID.
    if (sourcesByNumber.has(number)) return [];
    appendSource(number, {}, parsed);
  }

  return sources;
}

function terminalLink(label, url) {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function formatSource(source, hyperlinks) {
  const label = `[${source.number}] ${source.title}`;
  return hyperlinks && source.url ? terminalLink(label, source.url) : label;
}

function styleAnswer(text, theme) {
  if (!theme.color) return text;
  let codeBlock = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      codeBlock = !codeBlock;
      return theme.muted(line);
    }
    if (codeBlock) return line;
    if (/^#{1,6}\s+/.test(line)) return theme.strong(line.replace(/^#{1,6}\s+/, ''));
    // Only decorate small inline spans; preserve lists, links, and code verbatim.
    return line.replace(/(`[^`]+`)|(\*\*[^*]+\*\*)/g, (span, code) =>
      code ? theme.accent(span.slice(1, -1)) : theme.strong(span.slice(2, -2)));
  }).join('\n');
}

// The answer text and the sources it cites, as the app renders and saves them.
function resolveChatResponse(response) {
  const message = cleanText(response && typeof response.message === 'string' ? response.message : '');
  const parts = splitSourceBlock(message);
  const sources = collectSources(response, parseSourceBlock(parts.sourceBlock));
  const answer = sources.length ? parts.answer : message;
  return { answer: answer.replace(/(?:\r?\n[ \t]*)+$/, ''), sources };
}

function formatResolvedResponse(resolved, options) {
  const opts = options || {};
  const theme = createTheme({ isTTY: Boolean(opts.color) }, {});
  const answer = cleanText(resolved.answer);
  if (resolved.sources.length === 0) return styleAnswer(answer, theme);

  const sourceLine = resolved.sources
    .map((source) => formatSource(source, Boolean(opts.hyperlinks)))
    .join(' · ');

  return `${styleAnswer(answer, theme)}${answer ? '\n\n' : ''}${theme.muted(`Sources: ${sourceLine}`)}`;
}

function formatChatResponse(response, options) {
  return formatResolvedResponse(resolveChatResponse(response), options);
}

module.exports = {
  formatChatResponse,
  resolveChatResponse,
  formatResolvedResponse,
  isPlainTitle,
  safeHttpUrl,
  splitSourceBlock,
  parseSourceBlock
};
