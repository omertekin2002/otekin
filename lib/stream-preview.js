'use strict';

const { MAX_RESPONSE_BYTES, MAX_MESSAGE_CHARACTERS } = require('./chat-client');
const { cleanText, clipLine, PROGRESS_FRAMES } = require('./terminal');

// Provisional reply text is bounded in memory and only its tail is drawn.
const MAX_PROVISIONAL_CHARACTERS = MAX_RESPONSE_BYTES;
const PROVISIONAL_TAIL_CHARACTERS = MAX_MESSAGE_CHARACTERS;
const REDRAW_INTERVAL_MS = 80;

// Streamed text is untrusted and may stop mid-image, so hide unfinished image data too.
function provisionalText(text) {
  const visible = cleanText(text)
    .replace(/!\[[^\]\n]*\]\(\s*data:image\/[^)]*\)?/gi, '[generating image…]')
    .replace(/data:image\/[^\s)]*(?:\s+[A-Za-z0-9+/=]{40,})*/gi, '[generating image…]')
    .trim();
  if (visible.length <= PROVISIONAL_TAIL_CHARACTERS) return visible;
  return '…' + visible.slice(-PROVISIONAL_TAIL_CHARACTERS).replace(/^[\uDC00-\uDFFF]/, '');
}

let modules;

// wrap-ansi and string-width are ES modules, so they load on first use.
async function loadModules() {
  if (!modules) {
    const [wrap, width] = await Promise.all([import('wrap-ansi'), import('string-width')]);
    modules = { wrapAnsi: wrap.default, stringWidth: width.default };
  }
  return modules;
}

// Draws streamed reply text below the AI header, in place, until the canonical
// answer replaces it. The block, plus the empty row the cursor rests on, never grows
// past `rows - 2` rows, so it can always be erased by moving back up to its first row.
async function createStreamPreview(stream, options) {
  const opts = options || {};
  const { wrapAnsi, stringWidth } = await loadModules();
  const theme = opts.theme;
  const startedAt = opts.startedAt || Date.now();
  const statusLabel = typeof opts.statusLabel === 'function' ? opts.statusLabel : () => null;
  const segmenter = new Intl.Segmenter();
  let text = '';
  let drawn = null;
  let dirty = false;
  let closed = false;
  let frame = 0;
  let timer;

  // Terminals disagree about emoji sequences, so count every code point's width.
  const graphemeWidth = (grapheme) => Math.max(stringWidth(grapheme),
    Array.from(grapheme).reduce((sum, char) => sum + stringWidth(char), 0));
  const lineWidth = (line) => /^[\x20-\x7e]*$/.test(line) ? line.length
    : Array.from(segmenter.segment(line), ({ segment }) => graphemeWidth(segment))
      .reduce((sum, size) => sum + size, 0);
  const splitRow = (row, width) => {
    const size = lineWidth(row);
    if (size <= width) return [row];
    // Rewrap at word boundaries with room for the extra width, then split what still overflows.
    const narrower = width - (size - stringWidth(row));
    if (narrower >= width / 2) {
      const rows = wrapAnsi(row, narrower, { hard: true, trim: false }).split('\n').map((line) => line.trimEnd());
      if (rows.every((line) => lineWidth(line) <= width)) return rows;
    }
    return hardSplit(row, width);
  };
  const hardSplit = (row, width) => {
    const rows = [];
    let current = '';
    let size = 0;
    for (const { segment } of segmenter.segment(row)) {
      const next = graphemeWidth(segment);
      if (current && size + next > width) {
        rows.push(current);
        current = '';
        size = 0;
      }
      current += segment;
      size += next;
    }
    return rows.concat(current);
  };
  const textRows = (width, limit) => {
    // Only the tail can be shown, so wrap just enough of it to fill the rows.
    let visible = provisionalText(text).replace(/\t/g, '  ');
    const keep = limit * (width + 1) * 2;
    if (visible.length > keep) visible = visible.slice(-keep).replace(/^[\uDC00-\uDFFF]/, '');
    if (!visible) return [];
    const rows = [];
    for (const row of wrapAnsi(visible, width, { hard: true, trim: false }).split('\n')) {
      rows.push(...splitRow(row.trimEnd(), width));
    }
    return rows.slice(-limit);
  };
  const statusLine = (indent, width) => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const label = statusLabel() || 'Writing';
    const line = clipLine(`${PROGRESS_FRAMES[frame % PROGRESS_FRAMES.length]} ${label} · ${elapsed}s`, width);
    return { text: indent + theme.muted(line), width: indent.length + lineWidth(line) };
  };
  const layout = () => {
    const columns = Math.max(1, stream.columns || 80);
    const budget = Math.max(1, (stream.rows || 24) - 3);
    const indent = columns >= 6 ? '  ' : '';
    // Rows stop a column short of the edge, so no terminal wraps them on its own.
    const width = Math.max(1, columns - 1 - indent.length);
    const rows = textRows(width, Math.max(1, budget - 4));
    const status = statusLine(indent, width);
    const lines = ['', theme.strong(`${indent}AI`), '']
      .concat(rows.map((row) => indent + theme.muted(row)), status.text);
    const widths = [0, indent.length + 2, 0]
      .concat(rows.map((row) => indent.length + lineWidth(row)), status.width);
    return { columns, rows: stream.rows, lines: lines.slice(-budget), widths: widths.slice(-budget) };
  };
  const eraseSequence = () => {
    if (!drawn) return '';
    // After a resize the terminal may have rewrapped the rows, so count them again.
    const columns = Math.max(1, stream.columns || 80);
    const height = drawn.widths.reduce((sum, width) => sum + Math.max(1, Math.ceil(width / columns)), 0);
    return `\r\u001B[${height}A\u001B[J`;
  };
  const draw = () => {
    const next = layout();
    // Ending on an empty row keeps the cursor off the block: terminals reflow the
    // other rows on resize but may truncate the cursor's own row instead.
    stream.write((drawn ? eraseSequence() : '\u001B[?25l') + next.lines.join('\n') + '\n');
    drawn = next;
    dirty = false;
  };
  const tick = () => {
    frame += 1;
    if (!drawn) return;
    if (dirty || drawn.columns !== stream.columns || drawn.rows !== stream.rows) {
      draw();
      return;
    }
    // Only the status row changes between deltas; it is the row above the cursor.
    const indent = drawn.columns >= 6 ? '  ' : '';
    const status = statusLine(indent, Math.max(1, drawn.columns - 1 - indent.length));
    stream.write('\u001B[A\r\u001B[K' + status.text + '\n');
    drawn.widths[drawn.widths.length - 1] = status.width;
  };
  const erase = () => {
    if (!drawn) return;
    stream.write(eraseSequence());
    drawn = null;
  };

  return {
    update(delta) {
      if (closed || typeof delta !== 'string' || text.length >= MAX_PROVISIONAL_CHARACTERS) return;
      text += delta.slice(0, MAX_PROVISIONAL_CHARACTERS - text.length);
      if (timer) {
        dirty = true;
        return;
      }
      if (typeof opts.onShow === 'function') opts.onShow();
      draw();
      timer = setInterval(tick, REDRAW_INTERVAL_MS);
      timer.unref();
    },
    // Lets other output, such as completed tool lines, appear above the preview.
    around(write) {
      if (closed || !drawn) {
        write();
        return;
      }
      erase();
      try {
        write();
      } finally {
        draw();
      }
    },
    clear() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (drawn) {
        erase();
        stream.write('\u001B[?25h');
      }
    },
    get visible() {
      return Boolean(drawn);
    }
  };
}

module.exports = {
  MAX_PROVISIONAL_CHARACTERS,
  PROVISIONAL_TAIL_CHARACTERS,
  REDRAW_INTERVAL_MS,
  provisionalText,
  createStreamPreview
};
