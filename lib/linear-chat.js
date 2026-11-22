'use strict';

// Linear chat: a quiet, line-based conversation for screen readers and dumb terminals.
// It only ever appends whole lines. It never moves the cursor, redraws, animates or prints
// streamed provisional text: each reply is printed once, when it is complete.

const readline = require('readline');
const { cleanText, chatErrorMessage, createTheme, activityLabel } = require('./terminal');
const {
  cleanTitle, resolveChatResponse, formatResolvedResponse, safeHttpUrl, trimTrailingBlankLines
} = require('./chat-format');
const { saveGeneratedImages } = require('./chat-images');
const chatExport = require('./chat-export');
const { copyToClipboard } = require('./clipboard');
const chatHistory = require('./chat-history');
const { omittedTurns, TRIMMED_CONTEXT_NOTICE } = require('./chat-client');

const PROMPT = 'You: ';
const MAX_TOOL_LINES = 64;
const DEFAULT_WAKE_NOTICE_DELAY_MS = 750;
// Like the full-screen transcript, /save keeps the newest 100 messages and replies.
const MAX_TRANSCRIPT_ENTRIES = 100;
// Like the full-screen chat, saved history keeps the newest 50 prompts for ↑ recall.
const MAX_PROMPTS = 50;
const NOTHING_TO_COPY = 'Nothing to copy yet. Wait for a reply to finish.';
const NO_REPLY_YET = 'No reply yet. Ask a question first.';
// Commands a person at a terminal can run while a reply is on the way.
const IMMEDIATE_COMMANDS = ['help', 'last', 'retry', 'save', 'copy', 'clear'];
const HELP_LINES = [
  'Linear chat commands:',
  '  /help         Show this list',
  '  /last         Show the latest reply and its sources',
  '  /retry        Send your last message again',
  '  /save         Save the conversation as Markdown',
  '  /copy         Copy the latest reply and its sources',
  '  /clear        Forget the conversation and its saved history',
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
 * @property {string} [firstPrompt] Sent as the first question before any input is read, exactly as written
 *   apart from surrounding spaces: it never runs a command, so `/exit` is asked, not obeyed.
 * @property {boolean} [color] Style the header and model label; defaults to what `output` supports.
 * @property {boolean} [echo] Repeat each line after the prompt; defaults to true unless input is a terminal,
 *   which echoes typed lines itself.
 * @property {number} [wakeNoticeDelayMs] How long waking the service may take before one line says so.
 * @property {(response: ChatReply) => ChatReply} [saveImages] Replaces inline images before printing; tests may stub it.
 * @property {boolean} [interactive] Whether a person is typing: then /help, /last, /retry, /save, /copy and /clear run at once
 *   while a reply is on the way. Defaults to whether input is a terminal; piped lines always run in order.
 * @property {string} [saveDirectory] Where /save and the /copy fallback write files; defaults to the current directory.
 * @property {(text: string) => Promise<unknown>} [copy] Copies text to the clipboard and resolves a truthy value
 *   when it worked; defaults to the system clipboard.
 * @property {() => number} [now] The clock, in milliseconds, for answer times and saved file names.
 * @property {string | null} [historyFile] The saved chat history shared with the full-screen chat, or null when
 *   history is off. Only an interactive session reads or writes it; piped sessions never touch it.
 * @property {{ loadHistory: (file: string) => ({ history: object[], messages: object[], prompts: string[] } | null),
 *   saveHistory: (file: string, state: object) => void, clearHistory: (file: string) => void }} [historyStore]
 *   Reads and writes that file; defaults to chat-history.
 */

// A single word after "/" is a command; anything else is a chat message.
function commandName(line) {
  return /^\/[a-z]+$/i.test(line) ? line.slice(1).toLowerCase() : null;
}

function modelLabel(response) {
  const model = response && typeof response.model === 'string' ? response.model.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/.test(model) ? model : 'OTEKIN';
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

// What /retry names before it sends: the question's first line, cleaned and cut to 60 characters,
// with … when it was cut or the question has more lines.
const RETRY_LABEL_CHARACTERS = 60;
function retryLabel(question) {
  const [first, ...rest] = String(question).split('\n');
  const characters = Array.from(cleanText(first).trimEnd());
  const cut = characters.length > RETRY_LABEL_CHARACTERS;
  return characters.slice(0, RETRY_LABEL_CHARACTERS).join('') + (cut || rest.length ? '…' : '');
}

// Drops the transcript's last user message through the reply that answered it.
function withoutLastTurn(messages) {
  const answer = messages.findLastIndex((message) => message.role === 'assistant');
  const question = answer < 0 ? -1 : messages.findLastIndex((message, index) => index < answer && message.role === 'user');
  return question < 0 ? messages : messages.slice(0, question).concat(messages.slice(answer + 1));
}

// A transcript reply, shaped like the full-screen one so /save and /copy write the same Markdown
// and saved history keeps its text, sources and answer time.
function assistantRecord(model, resolved, answeredAt) {
  const markdown = formatResolvedResponse(resolved, { hyperlinks: true });
  return {
    role: 'assistant',
    model,
    ...(answeredAt ? { answeredAt } : {}),
    content: markdown,
    markdown,
    ...(resolved.sources.length ? { answer: resolved.answer, sources: resolved.sources } : {})
  };
}

// A saved transcript, as the full-screen chat restores it: replies saved with their sources get
// their links back for /save and /copy; notices and tool lines are kept as they are.
function restoredTranscript(messages) {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (typeof message.answer === 'string' && Array.isArray(message.sources)) {
      return assistantRecord(modelLabel(message), { answer: message.answer, sources: message.sources }, message.answeredAt);
    }
    return { ...message, model: modelLabel(message) };
  });
}

// How a prompt is typed again: a command-line prompt that looks like a command gets the // escape,
// so recalling it in the full-screen chat asks it rather than running it.
function promptAsTyped(prompt, literal) {
  return literal && prompt.startsWith('/') ? `/${prompt}` : prompt;
}

function isActivity(activity) {
  return Boolean(activity && typeof activity.id === 'string' && typeof activity.query === 'string' &&
    ['running', 'complete', 'error'].includes(activity.status));
}

// An answer and its sources as plain lines: the answer, then a numbered list of sources with URLs.
function formatLinearResolved(resolved, color) {
  const answer = formatResolvedResponse({ answer: resolved.answer, sources: [] }, {
    hyperlinks: false,
    color: Boolean(color)
  });
  if (resolved.sources.length === 0) return answer;
  const sources = resolved.sources.map((source) =>
    `${source.number}. ${source.title}${source.url ? ` ${source.url}` : ''}`);
  return `${answer}${answer ? '\n\n' : ''}Sources:\n${sources.join('\n')}`;
}

/** Formats a completed reply as plain lines: the answer, then a numbered list of sources with URLs. */
function formatLinearReply(response, options) {
  return formatLinearResolved(resolveChatResponse(response), (options || {}).color);
}

// A transcript reply's answer and sources, cleaned again as a live reply's are: saved history
// is read from disk, so its titles and links are never trusted as they are.
function transcriptReply(message) {
  if (typeof message.answer === 'string' && Array.isArray(message.sources)) {
    return {
      answer: message.answer,
      sources: message.sources.map((source) => ({
        number: source.number,
        title: cleanTitle(source.title) || `Source ${source.number}`,
        url: safeHttpUrl(source.url)
      }))
    };
  }
  return { answer: typeof message.markdown === 'string' ? message.markdown : message.content, sources: [] };
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
  // Piped sessions, like one-shot chat, never read or write saved history.
  const historyFile = interactive && options.historyFile ? options.historyFile : null;
  const historyStore = options.historyStore || chatHistory;
  let restored = null;
  if (historyFile) {
    try {
      restored = historyStore.loadHistory(historyFile);
    } catch {
      restored = null;
    }
  }

  /** @type {object[]} */
  let history = restored ? restored.history : [];
  // What /save and /copy read: questions and completed replies. Notices and tool lines restored
  // from a full-screen session stay in it so they are saved again, but /save and /copy skip them.
  /** @type {object[]} */
  let transcript = restored ? restoredTranscript(restored.messages) : [];
  // Recent questions, saved for the full-screen chat's ↑ recall.
  /** @type {string[]} */
  let prompts = restored ? restored.prompts.slice(-MAX_PROMPTS) : [];
  // A question whose reply failed or was cancelled; nothing of it is in history.
  /** @type {string | null} */
  let unanswered = null;
  // Whether this conversation has said that follow-ups no longer send its oldest turns.
  let trimNoticeShown = false;
  // Commands run while a reply is on the way, in the order they were typed.
  /** @type {Promise<void>} */
  let immediate = Promise.resolve();
  // How many of those have not finished; the session stays open for them after the input ends.
  let pendingImmediate = 0;
  // Lines waiting for their turn. `literal` marks the command-line prompt, which is always a question.
  /** @type {{ line: string, literal: boolean }[]} */
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

  // Saves the conversation after a completed reply. A failure never ends the chat.
  const saveConversation = () => {
    if (!historyFile) return;
    try {
      historyStore.saveHistory(historyFile, { history, messages: transcript, prompts });
    } catch (error) {
      writeLine(`Could not save chat history${errorCode(error)}. The chat still works.`);
    }
  };

  // Sends one question. A replacing retry leaves the answered turn in place until its new reply arrives.
  // `typed` is the line as entered, kept for prompt recall; retries have none.
  async function ask(prompt, replace = false, resend = false, typed = null) {
    const base = replace ? history.slice(0, -2) : history;
    let candidate;
    try {
      candidate = services.prepareRequestMessages(base, prompt);
    } catch (error) {
      errorStream.write(`Chat error: ${chatErrorMessage(error)}\n`);
      return;
    }
    unanswered = replace ? null : prompt;
    // Compared with the transcript, which after a restart can hold more turns than the saved request
    // history. A replacing retry leaves out the turn it replaces.
    const trimmed = !trimNoticeShown && omittedTurns(replace ? withoutLastTurn(transcript) : transcript, candidate) > 0;
    if (!replace && !resend) record({ role: 'user', content: prompt });
    if (typed !== null) prompts = prompts.concat(typed).slice(-MAX_PROMPTS);

    const controller = new AbortController();
    active = controller;
    if (trimmed) {
      trimNoticeShown = true;
      writeLine(TRIMMED_CONTEXT_NOTICE);
    }
    writeLine('Researching…');
    const tools = new Map();
    const onActivity = (activity) => {
      if (controller.signal.aborted || !isActivity(activity)) return;
      if (tools.has(activity.id) || tools.size >= MAX_TOOL_LINES) return;
      tools.set(activity.id, activity);
      writeLine(toolLine(activity, activity.status === 'running'));
    };

    let wakeTimer = null;
    // Which stage a failure came from: the wake-up check sends nothing of the conversation.
    /** @type {'readiness' | 'request'} */
    let stage = 'readiness';
    try {
      wakeTimer = setTimeout(() => {
        if (!controller.signal.aborted) writeLine('Waking chat service…');
      }, wakeNoticeDelayMs);
      await untilAborted(services.ensureChatServiceAwake({ signal: controller.signal }), controller.signal);
      clearTimeout(wakeTimer);
      if (controller.signal.aborted) return;
      stage = 'request';
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
      writeLine(trimTrailingBlankLines(reply));
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
      saveConversation();
    } catch (error) {
      // Piped lines run in order, so only a person at a terminal is pointed to /retry.
      if (!controller.signal.aborted) {
        errorStream.write(`Chat error: ${chatErrorMessage(error, stage, { retryHint: interactive })}\n`);
      }
    } finally {
      clearTimeout(wakeTimer);
      if (active === controller) active = null;
    }
  }

  async function retry() {
    if (active) {
      writeLine('A reply is on the way. Ctrl+C cancels it, then /retry sends it again.');
    } else if (unanswered !== null) {
      // The question may have scrolled away, and a screen reader reads only new lines, so a person
      // at a terminal hears which one is sent. Piped output stays as it was.
      if (interactive) writeLine(`Sending again: ${retryLabel(unanswered)}`);
      await ask(unanswered, false, true);
    } else if (lastTurn(history) !== null) {
      if (interactive) writeLine(`Sending again: ${retryLabel(lastTurn(history))}`);
      await ask(lastTurn(history), true);
    } else {
      writeLine('Nothing to retry yet. Send a message first.');
    }
  }

  // Forgets the conversation, cancelling a reply on the way, and deletes the saved history.
  function clear() {
    if (active) {
      active.abort();
      active = null;
    }
    history = [];
    transcript = [];
    prompts = [];
    unanswered = null;
    trimNoticeShown = false;
    if (historyFile) {
      try {
        historyStore.clearHistory(historyFile);
      } catch {
        writeLine('Conversation cleared, but the saved history could not be deleted');
        return;
      }
    }
    writeLine('Conversation cleared');
  }

  function save() {
    try {
      const file = chatExport.saveTranscript(saveDirectory, transcript, { date: new Date(now()) });
      writeLine(file ? `Saved the conversation to ${cleanText(file)}` : 'Nothing to save yet. Send a message first.');
    } catch (error) {
      writeLine(`Could not save the conversation${errorCode(error)}. The chat still works.`);
    }
  }

  // Prints the latest completed reply as a live reply is printed, with its answer time when it has one.
  // It reads only the transcript, so it works without the network; a reply still being written is never shown.
  function showLast() {
    /** @type {{ answeredAt?: string } | undefined} */
    const reply = transcript.findLast((message) => chatExport.replyMarkdown(message) !== null);
    if (!reply) {
      writeLine(NO_REPLY_YET);
      return;
    }
    if (active) writeLine('The reply being written is not finished yet. The previous reply:');
    const answered = chatExport.answerTimeLabel(reply.answeredAt, now());
    writeLine(theme.strong(modelLabel(reply)) + (answered ? ` · ${answered}` : '') + ':');
    writeLine(trimTrailingBlankLines(formatLinearResolved(transcriptReply(reply), color)));
    writeLine('');
  }

  // Copies the latest completed reply, never one still being written.
  async function copyReply() {
    /** @type {{ sources?: object[] } | undefined} */
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
      // A throwing clipboard counts as no clipboard: save the reply to a file instead.
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

  // Takes one turn. Only a line read from the input can be a command or use the // escape.
  async function handle(line, literal = false) {
    const trimmed = line.trim();
    if (!trimmed) return;
    // The echo is cleaned of terminal controls; the question is sent as typed.
    const shown = cleanText(line);
    if (promptShown) write(echo ? shown + '\n' : '');
    else write(PROMPT + shown + '\n');
    promptShown = false;

    const command = literal ? null : commandName(trimmed);
    if (command === 'exit' || command === 'quit') {
      end();
    } else if (command === 'help') {
      writeLine(HELP_LINES.join('\n'));
    } else if (command === 'last') {
      showLast();
    } else if (command === 'retry') {
      await retry();
    } else if (command === 'save') {
      save();
    } else if (command === 'copy') {
      await copyReply();
    } else if (command === 'clear') {
      clear();
    } else if (command) {
      writeLine(`Unknown command: /${command}. Type /help to see the commands.`);
    } else {
      const prompt = !literal && trimmed.startsWith('//') ? trimmed.slice(1) : trimmed;
      await ask(prompt, false, false, promptAsTyped(trimmed, literal));
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (!ended && queue.length) {
        const { line, literal } = queue.shift();
        await handle(line, literal);
      }
    } finally {
      draining = false;
    }
    if (ended) return;
    if (inputClosed && !pendingImmediate) end();
    else showPrompt();
  }

  const enqueue = (line) => {
    queue.push({ line, literal: false });
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
      pendingImmediate += 1;
      immediate = immediate.then(() => {
        if (ended) return undefined;
        return active ? handle(line) : enqueue(line);
      }).finally(() => {
        pendingImmediate -= 1;
        // The input ended while this command waited: finish the session once everything ran.
        if (inputClosed && !pendingImmediate && !draining) drain();
      });
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
  // One line says a saved conversation continues; its replies are not printed again.
  const asked = (messages) => messages.filter((message) => message.role === 'user').length;
  const questions = asked(transcript) || asked(history);
  if (restored && (history.length || transcript.length)) {
    writeLine(`Continuing your saved conversation (${questions} question${questions === 1 ? '' : 's'}). ` +
      '/last shows the latest reply; /clear forgets it; --no-history skips it.');
  }
  // Like one-shot chat, the command-line prompt is sent as written: `otekin chat --linear -- /exit`
  // asks about /exit, and the piped or typed lines after it are still read.
  if (options.firstPrompt && options.firstPrompt.trim()) queue.push({ line: options.firstPrompt, literal: true });
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
