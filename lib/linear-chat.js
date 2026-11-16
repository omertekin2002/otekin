'use strict';

// Linear chat: a quiet, line-based conversation for screen readers and dumb terminals.
// It only ever appends whole lines. It never moves the cursor, redraws, animates or prints
// streamed provisional text: each reply is printed once, when it is complete.

const readline = require('readline');
const { cleanText, createTheme, activityLabel } = require('./terminal');
const { resolveChatResponse, formatResolvedResponse } = require('./chat-format');
const { saveGeneratedImages } = require('./chat-images');
const chatExport = require('./chat-export');
const { copyToClipboard } = require('./clipboard');

const PROMPT = 'You: ';
const MAX_TOOL_LINES = 64;
const DEFAULT_WAKE_NOTICE_DELAY_MS = 750;
// Like the full-screen transcript, /save keeps the newest 100 messages and replies.
const MAX_TRANSCRIPT_ENTRIES = 100;
const NOTHING_TO_COPY = 'Nothing to copy yet. Wait for a reply to finish.';
// Commands a person at a terminal can run while a reply is on the way.
const IMMEDIATE_COMMANDS = ['help', 'retry', 'save', 'copy'];
const HELP_LINES = [
  'Linear chat commands:',
  '  /help         Show this list',
  '  /retry        Send your last message again',
  '  /save         Save the conversation as Markdown',
  '  /copy         Copy the latest reply and its sources',
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
 * @property {boolean} [interactive] Whether a person is typing: then /help, /retry, /save and /copy run at once
 *   while a reply is on the way. Defaults to whether input is a terminal; piped lines always run in order.
 * @property {string} [saveDirectory] Where /save and the /copy fallback write files; defaults to the current directory.
 * @property {(text: string) => Promise<unknown>} [copy] Copies text to the clipboard and resolves a truthy value
 *   when it worked; defaults to the system clipboard.
 * @property {() => number} [now] The clock, in milliseconds, for answer times and saved file names.
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

// A short error code such as EACCES, never the message, which may hold a path.
function errorCode(error) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? ` (${error.code})` : '';
}

// The last completed turn's question, when history ends with one: /retry replaces it.
function lastTurn(history) {
  const [user, assistant] = history.slice(-2);
  return user && user.role === 'user' && assistant && assistant.role === 'assistant' ? user.content : null;
}

// Drops the transcript's last user message through the reply that answered it.
function withoutLastTurn(messages) {
  const answer = messages.findLastIndex((message) => message.role === 'assistant');
  const question = answer < 0 ? -1 : messages.findLastIndex((message, index) => index < answer && message.role === 'user');
  return question < 0 ? messages : messages.slice(0, question).concat(messages.slice(answer + 1));
}

// A transcript reply, shaped like the full-screen one so /save and /copy write the same Markdown.
function assistantRecord(model, resolved, answeredAt) {
  return {
    role: 'assistant',
    model,
    answeredAt,
    markdown: formatResolvedResponse(resolved, { hyperlinks: true }),
    ...(resolved.sources.length ? { answer: resolved.answer, sources: resolved.sources } : {})
  };
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
  const interactive = options.interactive === undefined
    ? Boolean((/** @type {{ isTTY?: boolean }} */ (input)).isTTY)
    : Boolean(options.interactive);
  const saveDirectory = options.saveDirectory || process.cwd();
  const copy = options.copy || ((text) => copyToClipboard(text));
  const now = options.now || Date.now;

  /** @type {object[]} */
  let history = [];
  // What /save and /copy read: questions and completed replies, never errors, notices or tool lines.
  /** @type {object[]} */
  let transcript = [];
  // A question whose reply failed or was cancelled; nothing of it is in history.
  /** @type {string | null} */
  let unanswered = null;
  // Commands run while a reply is on the way, in the order they were typed.
  /** @type {Promise<void>} */
  let immediate = Promise.resolve();
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

  const record = (...entries) => {
    transcript = transcript.concat(entries).slice(-MAX_TRANSCRIPT_ENTRIES);
  };

  // Sends one question. A replacing retry leaves the answered turn in place until its new reply arrives.
  async function ask(prompt, replace = false) {
    const base = replace ? history.slice(0, -2) : history;
    let candidate;
    try {
      candidate = services.prepareRequestMessages(base, prompt);
    } catch (error) {
      errorStream.write(`Chat error: ${errorMessage(error)}\n`);
      return;
    }
    unanswered = replace ? null : prompt;
    if (!replace) record({ role: 'user', content: prompt });

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
      const saved = saveImages(response);
      const reply = formatLinearReply(saved, { color });
      const model = modelLabel(response);
      writeLine(theme.strong(model) + ':');
      writeLine(reply.replace(/(?:\r?\n[ \t]*)+$/, ''));
      writeLine('');
      history = candidate.concat(services.assistantMessageFromResponse(response));
      const entry = assistantRecord(model, resolveChatResponse(saved), new Date(now()).toISOString());
      if (replace) {
        transcript = withoutLastTurn(transcript).concat({ role: 'user', content: prompt }, entry)
          .slice(-MAX_TRANSCRIPT_ENTRIES);
      } else {
        record(entry);
      }
      unanswered = null;
    } catch (error) {
      if (!controller.signal.aborted) errorStream.write(`Chat error: ${errorMessage(error)}\n`);
    } finally {
      clearTimeout(wakeTimer);
      if (active === controller) active = null;
    }
  }

  async function retry() {
    if (active) {
      writeLine('A reply is on the way. Ctrl+C cancels it, then /retry sends it again.');
    } else if (unanswered !== null) {
      await ask(unanswered);
    } else if (lastTurn(history) !== null) {
      await ask(lastTurn(history), true);
    } else {
      writeLine('Nothing to retry yet. Send a message first.');
    }
  }

  function save() {
    try {
      const file = chatExport.saveTranscript(saveDirectory, transcript, { date: new Date(now()) });
      writeLine(file ? `Saved the conversation to ${cleanText(file)}` : 'Nothing to save yet. Send a message first.');
    } catch (error) {
      writeLine(`Could not save the conversation${errorCode(error)}. The chat still works.`);
    }
  }

  // Copies the latest completed reply, never one still being written.
  async function copyReply() {
    const reply = transcript.findLast((message) => chatExport.replyMarkdown(message) !== null);
    if (!reply) {
      writeLine(NOTHING_TO_COPY);
      return;
    }
    // The clipboard can take a moment; if the prompt came back meanwhile, the result goes on its own line.
    const report = (text) => {
      if (ended) return;
      const prompting = promptShown;
      endPromptLine();
      writeLine(text);
      if (prompting) showPrompt();
    };
    const writing = Boolean(active);
    const count = Array.isArray(reply.sources) ? reply.sources.length : 0;
    const what = `the ${writing ? 'previous' : 'latest'} reply${count ? ` (with ${count} source${count === 1 ? '' : 's'})` : ''}`;
    const unfinished = writing ? '. The reply being written is not finished yet' : '';
    let copied = false;
    try {
      copied = Boolean(await copy(chatExport.replyMarkdown(reply)));
    } catch {
      copied = false;
    }
    if (copied) {
      report(`Copied ${what} to the clipboard${unfinished}`);
      return;
    }
    try {
      const file = chatExport.saveReply(saveDirectory, reply, { date: new Date(now()) });
      report(`No clipboard available; saved ${what} to ${cleanText(file)}${unfinished}`);
    } catch (error) {
      report(`No clipboard available, and the reply could not be saved${errorCode(error)}. The chat still works.`);
    }
  }

  async function handle(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    // The echo is cleaned of terminal controls; the question is sent as typed.
    const shown = cleanText(line);
    if (promptShown) write(echo ? shown + '\n' : '');
    else write(PROMPT + shown + '\n');
    promptShown = false;

    const command = commandName(trimmed);
    if (command === 'exit' || command === 'quit') {
      end();
    } else if (command === 'help') {
      writeLine(HELP_LINES.join('\n'));
    } else if (command === 'retry') {
      await retry();
    } else if (command === 'save') {
      save();
    } else if (command === 'copy') {
      await copyReply();
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

  const enqueue = (line) => {
    queue.push(line);
    drain();
  };

  rl.on('line', (line) => {
    if (ended) return;
    // A terminal echoed the line already, so the next prompt starts on a fresh line.
    if (!echo && promptShown && !line.trim()) promptShown = false;
    // Someone typing a command while a reply is on the way gets an answer now. The reply is
    // printed whole when it arrives, so the command's lines land before or after it, never inside.
    const command = commandName(line.trim());
    if (interactive && active && command && IMMEDIATE_COMMANDS.includes(command)) {
      // One at a time, so each command's lines follow its own echo. If the reply has finished by
      // then, the command takes its turn like any other line, so /retry never sends a second request.
      immediate = immediate.then(() => (active ? handle(line) : enqueue(line)));
      return;
    }
    enqueue(line);
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
