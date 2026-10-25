import stringWidth from 'string-width';
import terminal from './terminal.js';

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

export function sanitizeInput(text) {
  return terminal.cleanText(text).replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
}

// Cursor offsets are UTF-16 indices, but edits always follow grapheme boundaries.
export function editDraft(draft, action, value = '') {
  const {text, cursor} = draft;
  const boundaries = [...segmenter.segment(text)].map(part => part.index).concat(text.length);
  const previous = boundaries.filter(index => index < cursor).pop() ?? 0;
  const next = boundaries.find(index => index > cursor) ?? text.length;
  const replace = (start, end, content) => ({
    text: text.slice(0, start) + content + text.slice(end),
    cursor: start + content.length
  });
  switch (action) {
    case 'insert': return replace(cursor, cursor, sanitizeInput(value));
    case 'left': return {text, cursor: previous};
    case 'right': return {text, cursor: next};
    case 'backspace': return replace(previous, cursor, '');
    case 'delete': return replace(cursor, next, '');
    case 'home': return {text, cursor: cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1};
    case 'end': {
      const end = text.indexOf('\n', cursor);
      return {text, cursor: end < 0 ? text.length : end};
    }
    case 'clear': return {text: '', cursor: 0};
    case 'killEnd': {
      const end = text.indexOf('\n', cursor);
      return replace(cursor, end < 0 ? text.length : end, '');
    }
    case 'wordBackspace': {
      const start = text.slice(0, cursor).replace(/\s*\S+\s*$/u, '').length;
      return replace(start, cursor, '');
    }
    default: return draft;
  }
}

export function layoutDraft(text, cursor, columns) {
  const width = Math.max(2, columns);
  const lines = [''];
  const positions = new Map([[0, {row: 0, column: 0}]]);
  let row = 0;
  let column = 0;
  for (const {segment, index} of segmenter.segment(text)) {
    const size = stringWidth(segment);
    if (segment !== '\n' && column + size > width) {
      lines.push('');
      row += 1;
      column = 0;
    }
    positions.set(index, column >= width ? {row: row + 1, column: 0} : {row, column});
    if (segment === '\n') {
      lines.push('');
      row += 1;
      column = 0;
    } else {
      lines[row] += segment;
      column += size;
    }
    positions.set(index + segment.length, column >= width ? {row: row + 1, column: 0} : {row, column});
  }
  if (column >= width) lines.push('');
  return {lines, positions, caret: positions.get(cursor) || {row, column}};
}

export function moveVertically(draft, direction, columns) {
  const {positions, caret} = layoutDraft(draft.text, draft.cursor, columns);
  const target = caret.row + direction;
  const candidates = [...positions].filter(([, position]) => position.row === target);
  if (!candidates.length) return draft;
  candidates.sort((a, b) => Math.abs(a[1].column - caret.column) - Math.abs(b[1].column - caret.column));
  return {...draft, cursor: candidates[0][0]};
}
