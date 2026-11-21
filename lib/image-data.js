'use strict';

// Raw `data:image/…` runs in reply text can be megabytes long. Regular expressions with
// quantified groups or classes over such runs overflow V8's backtracking stack, and ones that
// rescan the rest of the text from every `![` take quadratic time, so these helpers find each
// `data:image/` or `![` with a plain search and scan the data with loops.

const DATA_IMAGE = /data:image\//gi;
const PREFIX_LENGTH = 'data:image/'.length;
const BASE64_MARKER = ';base64,';

// The same code units as JavaScript's `\s`.
function isSpace(code) {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0xa0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f ||
    code === 0x205f || code === 0x3000 || code === 0xfeff;
}

// [A-Za-z0-9+/=]
function isBase64(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f || code === 0x3d;
}

// [a-z0-9.+-], case-insensitively
function isSubtype(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x2b || code === 0x2d;
}

// Whether `ascii` (lower-case ASCII) appears at `index`, ignoring ASCII case.
function hasAsciiAt(text, index, ascii) {
  if (index + ascii.length > text.length) return false;
  for (let offset = 0; offset < ascii.length; offset += 1) {
    let code = text.charCodeAt(index + offset);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    if (code !== ascii.charCodeAt(offset)) return false;
  }
  return true;
}

// Replaces every `data:image/` run that `findEnd(text, start)` accepts. `findEnd` returns the
// index just past the run, or -1 to leave that occurrence alone.
function replaceImageRuns(text, placeholder, findEnd) {
  const parts = [];
  let copied = 0;
  DATA_IMAGE.lastIndex = 0;
  let match;
  while ((match = DATA_IMAGE.exec(text))) {
    const end = findEnd(text, match.index);
    if (end < 0) continue;
    parts.push(text.slice(copied, match.index), placeholder);
    copied = end;
    DATA_IMAGE.lastIndex = end;
  }
  if (!parts.length) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

// Like /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{200,}/i: complete image data.
function completeImageEnd(text, start) {
  let index = afterBase64Subtype(text, start + PREFIX_LENGTH);
  if (index < 0) return -1;
  const dataStart = index;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (!isBase64(code) && !isSpace(code)) break;
    index += 1;
  }
  return index - dataStart >= 200 ? index : -1;
}

// Like /data:image\/[^\s)]*(?:\s+[A-Za-z0-9+/=]{40,})*/i: image data that may still be streaming.
function partialImageEnd(text, start) {
  let index = start + PREFIX_LENGTH;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isSpace(code) || code === 0x29) break;
    index += 1;
  }
  for (;;) {
    let wordStart = index;
    while (wordStart < text.length && isSpace(text.charCodeAt(wordStart))) wordStart += 1;
    if (wordStart === index) return index;
    let wordEnd = wordStart;
    while (wordEnd < text.length && isBase64(text.charCodeAt(wordEnd))) wordEnd += 1;
    if (wordEnd - wordStart < 40) return index;
    index = wordEnd;
  }
}

// A function that returns the first index of `search` at or after a position, or -1. The
// positions asked for must never decrease, so a long run without `search` is scanned only once.
function forwardIndexOf(text, search) {
  let found = -2;
  return (position) => {
    if (found === -2 || (found >= 0 && found < position)) found = text.indexOf(search, position);
    return found;
  };
}

// Replaces each Markdown image `![alt](target)` that `matchTarget(text, index)` accepts, where
// `index` is just past the `(`. `matchTarget` returns an object whose `end` is the index just
// past the image, or null to leave the image alone. `replace(alt, match)` gives the replacement.
// Like a regular expression starting /!\[[^\]]*\]\(/ (or /!\[[^\]\n]*\]\(/ with `altStopsAtNewline`),
// but in linear time: every `![` before the same `]` shares the same target, so a target that
// fails is tried only once.
function replaceMarkdownImages(text, altStopsAtNewline, matchTarget, replace) {
  const nextBracket = forwardIndexOf(text, ']');
  const nextNewline = forwardIndexOf(text, '\n');
  const parts = [];
  let copied = 0;
  let from = 0;
  for (;;) {
    const start = text.indexOf('![', from);
    if (start < 0) break;
    const close = nextBracket(start + 2);
    if (close < 0) break;
    const newline = altStopsAtNewline ? nextNewline(start + 2) : -1;
    if (newline >= 0 && newline < close) {
      from = newline + 1;
      continue;
    }
    const match = text.charCodeAt(close + 1) === 0x28 ? matchTarget(text, close + 2) : null;
    if (!match) {
      from = close + 1;
      continue;
    }
    parts.push(text.slice(copied, start), replace(text.slice(start + 2, close), match));
    copied = from = match.end;
  }
  if (!parts.length) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

// The index just past the `data:image/` at `index`, ignoring ASCII case, or -1.
function afterDataImage(text, index) {
  return hasAsciiAt(text, index, 'data:image/') ? index + PREFIX_LENGTH : -1;
}

// The index of the first character at or after `index` that isn't in \s.
function skipSpaces(text, index) {
  while (index < text.length && isSpace(text.charCodeAt(index))) index += 1;
  return index;
}

// The index just past the [a-z0-9.+-]+;base64, at `index`, ignoring ASCII case, or -1.
function afterBase64Subtype(text, index) {
  const subtypeStart = index;
  while (index < text.length && isSubtype(text.charCodeAt(index))) index += 1;
  if (index === subtypeStart || !hasAsciiAt(text, index, BASE64_MARKER)) return -1;
  return index + BASE64_MARKER.length;
}

function hideCompleteImageData(text, placeholder) {
  return replaceImageRuns(text, placeholder, completeImageEnd);
}

function hidePartialImageData(text, placeholder) {
  return replaceImageRuns(text, placeholder, partialImageEnd);
}

module.exports = {
  isSpace,
  isBase64,
  forwardIndexOf,
  replaceMarkdownImages,
  afterDataImage,
  afterBase64Subtype,
  skipSpaces,
  hideCompleteImageData,
  hidePartialImageData
};
