'use strict';

// Linear chat: a quiet, line-based conversation for screen readers and dumb terminals.
// It only ever appends whole lines. It never moves the cursor, redraws, animates or prints
// streamed provisional text: each reply is printed once, when it is complete.

const readline = require('readline');
const { cleanText, createTheme, activityLabel } = require('./terminal');
const { resolveChatResponse, formatResolvedResponse } = require('./chat-format');
const { saveGeneratedImages } = require('./chat-images');

const PROMPT = 'You: ';
const MAX_TOOL_LINES = 64;
const DEFAULT_WAKE_NOTICE_DELAY_MS = 750;
const HELP_LINES = [
  'Linear chat commands:',
  '  /help         Show this list',
  '  /exit, /quit  End the chat',
  '  //text        Send a message that starts with /',
  '  Ctrl+C        Cancel a reply, or end the chat when idle',
  '  Ctrl+D        End the chat when idle'
];

/**
 * The parts of a completed gateway reply that linear chat reads.
 * @typedef {{ message: string, model?: string, toolActivity?: object[], webSources?: object[] }} ChatReply
 */

/**
 * The chat client functions linear chat uses; tests inject fakes.
 * @typedef {object} LinearChatServices
 * @property {(history: object[], prompt: string) => object[]} prepareRequestMessages
 * @property {(options?: { signal?: AbortSignal }) => Promise<unknown>} ensureChatServiceAwake
 * @property {(messages: object[], options?: { signal?: AbortSignal, onActivity?: (activity: object) => void }) => Promise<ChatReply>} requestChat
 * @property {(response: ChatReply) => object} assistantMessageFromResponse
 */

/**
 * @typedef {object} LinearChatOptions
 * @property {NodeJS.ReadableStream} input Lines typed or piped in; one question per line.
 * @property {NodeJS.WritableStream} output The conversation: prompts, status lines and replies.
 * @property {NodeJS.WritableStream} [error] Chat errors; defaults to `output`.
 * @property {LinearChatServices} services
 * @property {string} [firstPrompt] Sent as the first turn before any input is read.
 * @property {boolean} [color] Style the header and model label; defaults to what `output` supports.
 * @property {boolean} [echo] Repeat each line after the prompt; defaults to true unless input is a terminal,
 *   which echoes typed lines itself.
 * @property {number} [wakeNoticeDelayMs] How long waking the service may take before one line says so.
 * @property {(response: ChatReply) => ChatReply} [saveImages] Replaces inline images before printing; tests may stub it.
 */

// A single word after "/" is a command; anything else is a chat message.
function commandName(line) {
  return /^\/[a-z]+$/i.test(line) ? line.slice(1).toLowerCase() : null;
}

function modelLabel(response) {
  const model = response && typeof response.model === 'string' ? response.model.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/.test(model) ? model : 'OTEKIN';
}

// The same safe-message rules as one-shot chat: a cleaned message and a well-formed request ID.
function errorMessage(error) {
  const message = error && error.message ? cleanText(error.message) : 'Chat request failed.';
  const requestId = error && typeof error.requestId === 'string' ? error.requestId.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) return message;
  return `${message} (Request ID: ${requestId})`;
}

// "Searching: query" rather than the full-screen "Searching  query", read aloud more clearly.
function toolLine(activity, running) {
  const label = activityLabel(activity, running);
  const gap = label.indexOf('  ');
  return gap < 0 ? label : `${label.slice(0, gap)}: ${label.slice(gap + 2)}`;
}

// Settles as soon as the request is cancelled, even if the service ignores its abort signal.
function untilAborted(promise, signal) {
  return Promise.race([promise, new Promise((_resolve, reject) => {
    const cancelled = () => reject(new Error('Chat request was cancelled.'));
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
  })]);
}

function isActivity(activity) {
  return Boolean(activity && typeof activity.id === 'string' && typeof activity.query === 'string' &&
    ['running', 'complete', 'error'].includes(activity.status));
}

/** Formats a completed reply as plain lines: the answer, then a numbered list of sources with URLs. */
function formatLinearReply(response, options) {
  const opts = options || {};
  const resolved = resolveChatResponse(response);
  const answer = formatResolvedResponse({ answer: resolved.answer, sources: [] }, {
    hyperlinks: false,
    color: Boolean(opts.color)
  });
  if (resolved.sources.length === 0) return answer;
  const sources = resolved.sources.map((source) =>
    `${source.number}. ${source.title}${source.url ? ` ${source.url}` : ''}`);
  return `${answer}${answer ? '\n\n' : ''}Sources:\n${sources.join('\n')}`;
}

/**
 * Whether a promptless `otekin chat` should open linear chat: on a terminal that cannot show the
 * full-screen workspace because it is TERM=dumb.
 * @param {{ stdinIsTTY?: boolean, stdoutIsTTY?: boolean, term?: string, nonInteractive?: boolean }} state
 */
function prefersLinearChat(state) {
  return Boolean(!state.nonInteractive && state.stdinIsTTY && state.stdoutIsTTY && state.term === 'dumb');
}

/**
 * Starts a linear chat session. `finished` resolves when the session ends (EOF, /exit, /quit,
 * or Ctrl+C while idle). Call `interrupt()` for Ctrl+C: it cancels a reply in flight, or ends
 * the session when idle.
 * @param {LinearChatOptions} options
 * @returns {{ finished: Promise<void>, interrupt: () => void }}
 */
function startLinearChat(options) {
  const { input, output, services } = options;
  const errorStream = options.error || output;
  const color = options.color === undefined ? createTheme(output).color : Boolean(options.color);
  const theme = createTheme({ isTTY: color }, {});
  const echo = options.echo === undefined ? !(/** @type {{ isTTY?: boolean }} */ (input)).isTTY : Boolean(options.echo);
  const wakeNoticeDelayMs = options.wakeNoticeDelayMs === undefined
    ? DEFAULT_WAKE_NOTICE_DELAY_MS
    : options.wakeNoticeDelayMs;
  const saveImages = options.saveImages || saveGeneratedImages;

  /** @type {object[]} */
  let history = [];
  /** @type {string[]} */
  const queue = [];
  /** @type {AbortController | null} */
  let active = null;
  let inputClosed = false;
  let ended = false;
  let draining = false;
  let promptShown = false;
  let resolveFinished;
  /** @type {Promise<void>} */
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });

  const write = (text) => output.write(text);
  const writeLine = (text) => write(text + '\n');

  // A terminal never sees a line half-written by us: the prompt is the only unterminated text.
  const endPromptLine = () => {
    if (promptShown) write('\n');
    promptShown = false;
  };

  const showPrompt = () => {
    if (ended || promptShown || inputClosed || queue.length) return;
    write(PROMPT);
    promptShown = true;
  };

  const rl = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });

  const end = () => {
    if (ended) return;
    ended = true;
    queue.length = 0;
    endPromptLine();
    rl.close();
    resolveFinished();
  };

  async function ask(prompt) {
    let candidate;
    try {
      candidate = services.prepareRequestMessages(history, prompt);
    } catch (error) {
      errorStream.write(`Chat error: ${errorMessage(error)}\n`);
      return;
    }

    const controller = new AbortController();
    active = controller;
    writeLine('Researching…');
    const tools = new Map();
    const onActivity = (activity) => {
      if (controller.signal.aborted || !isActivity(activity)) return;
      if (tools.has(activity.id) || tools.size >= MAX_TOOL_LINES) return;
      tools.set(activity.id, activity);
      writeLine(toolLine(activity, activity.status === 'running'));
    };

    let wakeTimer = null;
    try {
      wakeTimer = setTimeout(() => {
        if (!controller.signal.aborted) writeLine('Waking chat service…');
      }, wakeNoticeDelayMs);
      await untilAborted(services.ensureChatServiceAwake({ signal: controller.signal }), controller.signal);
      clearTimeout(wakeTimer);
      if (controller.signal.aborted) return;
      const response = await untilAborted(
        services.requestChat(candidate, { signal: controller.signal, onActivity }),
        controller.signal
      );
      // A reply that arrives after Ctrl+C is never printed.
      if (controller.signal.aborted) return;
      // A JSON-only gateway reports its tools only with the reply.
      if (response && Array.isArray(response.toolActivity)) {
        response.toolActivity.forEach((activity) => {
          if (!isActivity(activity) || tools.has(activity.id) || tools.size >= MAX_TOOL_LINES) return;
          tools.set(activity.id, activity);
          writeLine(toolLine(activity, false));
        });
      }
      const reply = formatLinearReply(saveImages(response), { color });
      writeLine(theme.strong(modelLabel(response)) + ':');
      writeLine(reply.replace(/(?:\r?\n[ \t]*)+$/, ''));
      writeLine('');
      history = candidate.concat(services.assistantMessageFromResponse(response));
    } catch (error) {
      if (!controller.signal.aborted) errorStream.write(`Chat error: ${errorMessage(error)}\n`);
    } finally {
      clearTimeout(wakeTimer);
      if (active === controller) active = null;
    }
  }

  async function handle(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (promptShown) write(echo ? line + '\n' : '');
    else write(PROMPT + line + '\n');
    promptShown = false;

    const command = commandName(trimmed);
    if (command === 'exit' || command === 'quit') {
      end();
    } else if (command === 'help') {
      writeLine(HELP_LINES.join('\n'));
    } else if (command) {
      writeLine(`Unknown command: /${command}. Type /help to see the commands.`);
    } else {
      await ask(trimmed.startsWith('//') ? trimmed.slice(1) : trimmed);
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (!ended && queue.length) await handle(queue.shift());
    } finally {
      draining = false;
    }
    if (ended) return;
    if (inputClosed) end();
    else showPrompt();
  }

  rl.on('line', (line) => {
    if (ended) return;
    // A terminal echoed the line already, so the next prompt starts on a fresh line.
    if (!echo && promptShown && !line.trim()) promptShown = false;
    queue.push(line);
    drain();
  });
  rl.on('close', () => {
    inputClosed = true;
    if (!draining) drain();
  });

  writeLine(theme.strong('otekin linear chat') + theme.muted(' · one line at a time, no animation'));
  writeLine('Type a question and press Enter. /help lists commands, /exit ends the chat. Ctrl+C cancels a reply.');
  if (options.firstPrompt && options.firstPrompt.trim()) queue.push(options.firstPrompt);
  // Let a caller attach to `finished` before the first turn starts.
  setImmediate(drain);

  return {
    finished,
    interrupt() {
      if (ended) return;
      if (active) {
        active.abort();
        active = null;
        writeLine('Cancelled.');
        return;
      }
      end();
    }
  };
}

module.exports = {
  HELP_LINES,
  PROMPT,
  commandName,
  formatLinearReply,
  modelLabel,
  prefersLinearChat,
  startLinearChat
};
