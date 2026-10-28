import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, render, useApp, useCursor, useInput, usePaste, useWindowSize} from 'ink';
import wrapAnsi from 'wrap-ansi';
import chatClient from './chat-client.js';
import chatExport from './chat-export.js';
import chatFormat from './chat-format.js';
import chatHistory from './chat-history.js';
import chatImages from './chat-images.js';
import profile from './profile.js';
import streamPreview from './stream-preview.js';
import terminal from './terminal.js';
import {editDraft, layoutDraft, moveVertically} from './editor.mjs';

const h = React.createElement;
const EMPTY_DRAFT = {text: '', cursor: 0};
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const COMMANDS = [
  ['help', 'Keyboard shortcuts and commands'],
  ['profile', 'Meet Ömer Tekin'],
  ['website', 'Visit my personal website'],
  ['linkedin', 'Find me on LinkedIn'],
  ['cv', 'Open my résumé'],
  ['retry', 'Send your last message again'],
  ['save', 'Save the conversation as Markdown'],
  ['clear', 'Start a fresh conversation'],
  ['exit', 'Return to your shell']
];
const {MAX_PROVISIONAL_CHARACTERS, provisionalText} = streamPreview;
const RESTORED = 'Restored your last conversation · /clear to forget it';
const NAVIGATION = [
  ['chat', 'Chat'], ['profile', 'About Ömer'], ['website', 'Website ↗'],
  ['linkedin', 'LinkedIn ↗'], ['cv', 'Résumé ↗'], ['help', 'Help & shortcuts']
];

function failureMessage(error) {
  const message = terminal.cleanText(error?.message || 'Chat request failed.');
  const id = typeof error?.requestId === 'string' ? error.requestId.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? `${message} (Request ID: ${id})` : message;
}

// A single word after "/" is a command; anything else is a chat message.
function commandName(prompt) {
  return /^\/[a-z]+$/i.test(prompt) ? prompt.slice(1).toLowerCase() : null;
}

function modelLabel(response) {
  const model = typeof response?.model === 'string' ? response.model.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/.test(model) ? model : 'OTEKIN';
}

// Saved history is read once per app, before the first render.
function restoreHistory(file, store) {
  const restored = file ? store.loadHistory(file) : null;
  if (!restored) return null;
  return {...restored, messages: restored.messages.map(message =>
    message.role === 'assistant' ? {...message, model: modelLabel(message)} : message)};
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? ` (${error.code})` : '';
}

function saveFailure(error) {
  return `Could not save chat history${errorCode(error)}. The chat still works.`;
}

// The last completed turn, when history ends with one: /retry replaces it.
function lastTurn(history) {
  const [user, assistant] = history.slice(-2);
  return user?.role === 'user' && assistant?.role === 'assistant' ? user.content : null;
}

// Drops the transcript's last user message through the reply that answered it.
function withoutLastTurn(messages) {
  const answer = messages.findLastIndex(message => message.role === 'assistant');
  const question = answer < 0 ? -1 : messages.findLastIndex((message, index) => index < answer && message.role === 'user');
  return question < 0 ? messages : messages.slice(0, question).concat(messages.slice(answer + 1));
}

// Ink styles text through chalk, which ignores NO_COLOR. Without color, drop every
// styling prop so the workspace emits no SGR codes, like the theme's own styles.
const STYLE_PROPS = ['color', 'dimColor', 'bold', 'inverse', 'borderColor'];

function styled(theme, props) {
  if (theme.color) return props;
  const plain = {...props};
  for (const name of STYLE_PROPS) delete plain[name];
  return plain;
}

function toolLines(activities, theme) {
  return activities.map(activity => {
    const mark = activity.status === 'error' ? '!' : activity.status === 'running' ? '·' : '✓';
    const text = `${mark} ${terminal.activityLabel(activity, activity.status === 'running')}`;
    return activity.status === 'error' ? theme.warning(text + ' (failed)') : theme.muted(text);
  }).join('\n');
}

function Welcome({compact, theme}) {
  return h(Box, {flexDirection: 'column', paddingX: compact ? 1 : 3, paddingTop: compact ? 0 : 2},
    h(Text, styled(theme, {color: 'cyan', bold: true}), '›_ otekin'),
    h(Text, styled(theme, {dimColor: true}), 'A little more personal. A lot more possible.'),
    h(Text, null, ''),
    h(Text, styled(theme, {bold: true}), profile.greeting),
    h(Text, styled(theme, {dimColor: true}), profile.tagline),
    h(Text, null, ''),
    h(Text, null, 'Ask anything. Follow the research as it happens.'),
    h(Text, styled(theme, {dimColor: true}), 'Or type / to explore my work and find your way around.'),
    !compact && h(Text, null, '\nTry a conversation'),
    !compact && h(Text, styled(theme, {dimColor: true}), '  Explain a tricky concept\n  What happened in the world today?\n  Help me think through an idea')
  );
}

function Info({view, links}) {
  const lines = view === 'profile' ? [
    profile.name, '', profile.tagline, '',
    'Find my work, connect, or take a look at my résumé.', '',
    `Website   ${links.website}`, `LinkedIn  ${links.linkedin}`, `Résumé    ${links.cv}`, '',
    'Use /website, /linkedin, or /cv to open a link.', 'Type a question to return to chat.'
  ] : [
    'Make yourself at home', '',
    'Enter              Send a message or run a command',
    'Ctrl+J / Alt+Enter Add a new line (Shift+Enter where supported)',
    '↑ / ↓              Move in your draft; recall previous prompts',
    '← / →  Home / End  Move the editing cursor',
    'Ctrl+W / U / K     Delete a word / draft / rest of line',
    'Page Up / Down     Scroll the conversation',
    'Ctrl+Home / End    Jump to oldest / newest messages',
    'Tab                Focus navigation; complete a slash command',
    'Esc                Cancel a request; return to the composer',
    'Ctrl+C             Cancel a request; exit when idle',
    'Ctrl+D             Exit with an empty draft',
    '//                 Start a message with a literal /', '',
    ...COMMANDS.map(([name, description]) => `/${name.padEnd(17)} ${description}`)
  ];
  return lines.join('\n');
}

export function TerminalApp({links, version, options = {}, openInBrowser, services = chatClient, historyFile = null, historyStore = chatHistory, saveDirectory = process.cwd(), transcriptStore = chatExport, env = process.env}) {
  const {exit} = useApp();
  const {setCursorPosition} = useCursor();
  const {columns, rows} = useWindowSize();
  const theme = useMemo(() => terminal.createTheme({isTTY: true}, env), [env]);
  const [draft, setDraftState] = useState(EMPTY_DRAFT);
  const draftRef = useRef(EMPTY_DRAFT);
  const [restored] = useState(() => restoreHistory(historyFile, historyStore));
  const history = useRef(restored?.history || []);
  const prompts = useRef(restored?.prompts || []);
  const saveRequested = useRef(false);
  // A prompt whose reply failed or was cancelled; nothing of it is in history.
  const unanswered = useRef(null);
  const recall = useRef({index: -1, saved: EMPTY_DRAFT});
  const active = useRef(null);
  const mounted = useRef(true);
  const [messages, setMessages] = useState(restored?.messages || []);
  const [activities, setActivities] = useState([]);
  const stream = useRef(null);
  const [provisional, setProvisional] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(restored ? RESTORED : 'Ready when you are');
  const [tick, setTick] = useState(0);
  const [view, setView] = useState('chat');
  const [focus, setFocus] = useState('composer');
  const [nav, setNav] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [scroll, setScroll] = useState(0);
  const startedAt = useRef(0);
  const wide = columns >= 100;
  const sidebarWidth = wide ? 27 : 0;
  const mainWidth = Math.max(8, columns - 2 - sidebarWidth);
  const inputWidth = Math.max(2, mainWidth - 6);
  const layout = useMemo(() => layoutDraft(draft.text, draft.cursor, inputWidth), [draft, inputWidth]);
  const draftRows = Math.min(layout.lines.length, Math.max(1, Math.min(5, Math.floor((rows - 7) / 3))));
  const draftStart = Math.max(0, layout.caret.row - draftRows + 1);
  const matches = !paletteDismissed && focus === 'composer' && /^\/[^\s]*$/.test(draft.text)
    ? COMMANDS.filter(([name]) => name.startsWith(draft.text.slice(1).toLowerCase())) : [];
  const paletteRows = Math.min(matches.length, Math.max(0, Math.min(5, rows - draftRows - 10)));
  const selectedCommand = Math.min(commandIndex, Math.max(0, matches.length - 1));
  const commandStart = Math.max(0, selectedCommand - paletteRows + 1);
  const viewportHeight = Math.max(1, rows - 3 - (draftRows + 2) - 1 - paletteRows);
  const compact = rows < 26 || mainWidth < 65;

  const setDraft = value => {
    draftRef.current = value;
    setDraftState(value);
    setPaletteDismissed(false);
    setCommandIndex(0);
  };
  const append = (...entries) => setMessages(previous => previous.concat(entries).slice(-100));
  const cancel = (notice = 'Cancelled. Ready for your next message.') => {
    if (!active.current) return;
    active.current.notice = notice;
    active.current.abort();
    stream.current = null;
    setProvisional('');
  };
  // Deltas are collected as they arrive and drawn at most once per busy tick.
  const flushProvisional = () => {
    const current = stream.current;
    if (!current || !current.dirty || current.controller.signal.aborted) return;
    current.dirty = false;
    setProvisional(provisionalText(current.text));
    setStatus('Writing');
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  // Save once the completed reply is in the transcript.
  useEffect(() => {
    if (!saveRequested.current || !historyFile) return;
    saveRequested.current = false;
    try {
      historyStore.saveHistory(historyFile, {history: history.current, messages, prompts: prompts.current});
    } catch (error) {
      setStatus(saveFailure(error));
    }
  }, [messages]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      setTick(value => value + 1);
      flushProvisional();
    }, 100);
    return () => clearInterval(timer);
  }, [busy]);

  async function runCommand(command) {
    setFocus('composer');
    setScroll(0);
    if (command === 'exit' || command === 'quit') {
      cancel();
      exit();
    } else if (command === 'chat' || command === 'help' || command === 'profile') {
      setView(command);
    } else if (command === 'clear') {
      cancel('Conversation cleared');
      history.current = [];
      unanswered.current = null;
      setMessages([]);
      setActivities([]);
      setView('chat');
      setStatus('Conversation cleared');
      if (historyFile) {
        // Forget everything that was saved, including prompt recall.
        saveRequested.current = false;
        prompts.current = [];
        recall.current.index = -1;
        try {
          historyStore.clearHistory(historyFile);
        } catch {
          setStatus('Conversation cleared, but the saved history could not be deleted');
        }
      }
    } else if (command === 'retry') {
      setView('chat');
      if (active.current) {
        setStatus('A reply is on the way. Esc cancels it, then /retry sends it again.');
      } else if (unanswered.current !== null) {
        await send(unanswered.current);
      } else if (lastTurn(history.current) !== null) {
        await send(lastTurn(history.current), {replace: true});
      } else {
        append({role: 'notice', content: 'Nothing to retry yet. Send a message first.'});
      }
    } else if (command === 'save') {
      setView('chat');
      try {
        const file = transcriptStore.saveTranscript(saveDirectory, messages);
        append({role: 'notice', content: file ? `Saved the conversation to ${terminal.cleanText(file)}`
          : 'Nothing to save yet. Send a message first.'});
      } catch (error) {
        append({role: 'notice', content: `Could not save the conversation${errorCode(error)}. The chat still works.`});
      }
    } else if (Object.hasOwn(links, command)) {
      const url = links[command];
      setView('chat');
      append({role: 'notice', content: `${command === 'cv' ? 'Résumé' : command}: ${url}`});
      if (!options.noOpen) {
        try {
          await openInBrowser(url);
        } catch {
          if (mounted.current) append({role: 'notice', content: 'Could not open a browser. Use the link above.'});
        }
      }
    } else {
      setView('chat');
      append({role: 'notice', content: `Unknown command: /${command}. Type /help to see the commands.`});
    }
  }

  async function submit(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const command = commandName(trimmed);
    if (command) {
      setDraft(EMPTY_DRAFT);
      await runCommand(command);
      return;
    }
    const prompt = trimmed.startsWith('//') ? trimmed.slice(1) : trimmed;
    if (active.current) {
      setStatus('A reply is on the way. Esc cancels it; your draft is saved.');
      return;
    }
    await send(prompt, {entered: trimmed});
  }

  // Sends one prompt. A replacing retry leaves the answered turn in place until its new reply arrives.
  async function send(prompt, {entered = null, replace = false} = {}) {
    const base = replace ? history.current.slice(0, -2) : history.current;
    let candidate;
    try {
      candidate = services.prepareRequestMessages(base, prompt);
    } catch (error) {
      setStatus(failureMessage(error));
      return;
    }
    if (entered !== null) {
      setDraft(EMPTY_DRAFT);
      recall.current.index = -1;
      prompts.current = prompts.current.concat(entered).slice(-50);
    }
    unanswered.current = replace ? null : prompt;
    setView('chat');
    setScroll(0);
    if (!replace) append({role: 'user', content: prompt});
    const controller = new AbortController();
    active.current = controller;
    startedAt.current = Date.now();
    setBusy(true);
    setActivities([]);
    setProvisional('');
    setStatus('Connecting to chat service');
    const reply = {controller, text: '', dirty: false};
    stream.current = reply;
    const onDelta = text => {
      if (!mounted.current || controller.signal.aborted || stream.current !== reply || typeof text !== 'string') return;
      if (reply.text.length >= MAX_PROVISIONAL_CHARACTERS) return;
      reply.text += text.slice(0, MAX_PROVISIONAL_CHARACTERS - reply.text.length);
      reply.dirty = true;
    };
    const tools = new Map();
    const onActivity = activity => {
      if (!mounted.current || controller.signal.aborted || !activity || typeof activity.id !== 'string') return;
      if (tools.get(activity.id)?.status !== 'running' && tools.has(activity.id)) return;
      if (!tools.has(activity.id) && tools.size >= 64) return;
      tools.set(activity.id, activity);
      setActivities([...tools.values()]);
      const running = [...tools.values()].filter(tool => tool.status === 'running');
      setStatus(running.length ? terminal.activityLabel(running[running.length - 1], true) : 'Thinking');
    };
    try {
      await services.ensureChatServiceAwake({signal: controller.signal});
      if (controller.signal.aborted) return;
      setStatus('Thinking');
      const response = await services.requestChat(candidate, {signal: controller.signal, onActivity, onDelta});
      if (!mounted.current || controller.signal.aborted) return;
      if (Array.isArray(response.toolActivity)) response.toolActivity.forEach(onActivity);
      const saved = chatImages.saveGeneratedImages(response);
      const entries = [
        ...(tools.size ? [{role: 'tools', content: toolLines([...tools.values()], theme)}] : []),
        {
          role: 'assistant', model: modelLabel(response),
          content: chatFormat.formatChatResponse(saved, {hyperlinks: true, color: theme.color}),
          // Unstyled, so /save keeps the reply's own Markdown. Never written to saved history.
          markdown: chatFormat.formatChatResponse(saved, {hyperlinks: true})
        }
      ];
      if (replace) setMessages(previous => withoutLastTurn(previous).concat({role: 'user', content: prompt}, entries).slice(-100));
      else append(...entries);
      history.current = candidate.concat(services.assistantMessageFromResponse(response));
      unanswered.current = null;
      saveRequested.current = true;
      setStatus('Ready when you are');
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        append({role: 'error', content: failureMessage(error)});
        setStatus('Try again when you’re ready');
      }
    } finally {
      if (active.current === controller) active.current = null;
      if (stream.current === reply) stream.current = null;
      if (mounted.current) {
        setBusy(false);
        setActivities([]);
        setProvisional('');
        if (controller.signal.aborted) setStatus(controller.notice);
      }
    }
  }

  const transcript = useMemo(() => {
    let content;
    if (view !== 'chat') content = Info({view, links});
    else content = messages.map(message => {
      if (message.role === 'tools') return message.content + '\n';
      const label = message.role === 'user' ? theme.accent(theme.strong('YOU'))
        : message.role === 'assistant' ? theme.strong(message.model)
          : message.role === 'error' ? theme.warning('! CHAT ERROR') : theme.muted('•');
      return `${label}\n${message.content}\n`;
    }).join('\n');
    if (view === 'chat' && activities.length) content += '\n' + toolLines(activities, theme);
    if (view === 'chat' && provisional) {
      content += `${activities.length ? '\n\n' : '\n'}${theme.muted('WRITING · provisional')}\n${provisional}\n`;
    }
    return wrapAnsi(content, Math.max(2, mainWidth - 4), {hard: true, trim: false}).split('\n');
  }, [messages, activities, provisional, view, links, theme, mainWidth]);
  const maxScroll = Math.max(0, transcript.length - viewportHeight);
  const offset = Math.min(scroll, maxScroll);
  const firstLine = view === 'chat' ? maxScroll - offset : offset;
  // Chat scrolls from the bottom. While scrolled up, grow the offset with the
  // transcript so the lines being read stay put as new content arrives.
  // Apply the change to the previous offset, then clamp it to the new bounds.
  const [scrollAnchor, setScrollAnchor] = useState({length: transcript.length, view, maxScroll});
  if (scrollAnchor.length !== transcript.length || scrollAnchor.view !== view || scrollAnchor.maxScroll !== maxScroll) {
    setScrollAnchor({length: transcript.length, view, maxScroll});
    const previous = Math.min(scroll, scrollAnchor.maxScroll);
    if (scrollAnchor.view === view && view === 'chat' && previous > 0 && scrollAnchor.length !== transcript.length) {
      setScroll(Math.max(0, Math.min(maxScroll, previous + transcript.length - scrollAnchor.length)));
    }
  }

  usePaste(text => {
    setFocus('composer');
    const edited = editDraft(draftRef.current, 'insert', text);
    if (edited.text.length > chatClient.MAX_MESSAGE_CHARACTERS) {
      setStatus(`Keep messages under ${chatClient.MAX_MESSAGE_CHARACTERS} characters. Paste was not inserted.`);
      return;
    }
    setDraft(edited);
    recall.current.index = -1;
  });

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'c') {
      if (active.current) cancel();
      else exit();
      return;
    }
    if (key.escape) {
      if (active.current) cancel();
      setFocus('composer');
      setPaletteDismissed(true);
      return;
    }
    if (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end))) {
      if (key.ctrl && key.home) setScroll(view === 'chat' ? maxScroll : 0);
      else if (key.ctrl && key.end) setScroll(view === 'chat' ? 0 : maxScroll);
      else {
        const direction = (key.pageUp ? -1 : 1) * (view === 'chat' ? -1 : 1);
        setScroll(Math.max(0, Math.min(maxScroll, offset + direction * Math.max(1, viewportHeight - 2))));
      }
      return;
    }
    if (key.tab) {
      if (matches.length) setDraft({text: '/' + matches[selectedCommand][0], cursor: matches[selectedCommand][0].length + 1});
      else if (wide) setFocus(focus === 'composer' ? 'navigation' : 'composer');
      else if (!draftRef.current.text) { setDraft({text: '/', cursor: 1}); setFocus('composer'); }
      return;
    }
    if (focus === 'navigation' && wide) {
      if (key.upArrow) setNav((nav + NAVIGATION.length - 1) % NAVIGATION.length);
      else if (key.downArrow) setNav((nav + 1) % NAVIGATION.length);
      else if (key.return) void runCommand(NAVIGATION[nav][0]);
      return;
    }
    if (matches.length && (key.upArrow || key.downArrow)) {
      setCommandIndex((selectedCommand + (key.upArrow ? -1 : 1) + matches.length) % matches.length);
      return;
    }
    if (key.return && !key.meta && !key.shift) {
      const text = matches.length ? '/' + matches[selectedCommand][0] : draftRef.current.text;
      void submit(text);
      return;
    }
    if (key.ctrl && input === 'd' && !draftRef.current.text) { cancel(); exit(); return; }
    if ((key.return && (key.meta || key.shift)) || (key.ctrl && input === 'j')) {
      const edited = editDraft(draftRef.current, 'insert', '\n');
      if (edited.text.length <= chatClient.MAX_MESSAGE_CHARACTERS) setDraft(edited);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const currentLayout = layoutDraft(draftRef.current.text, draftRef.current.cursor, inputWidth);
      if (currentLayout.lines.length > 1 && recall.current.index < 0) {
        setDraft(moveVertically(draftRef.current, key.upArrow ? -1 : 1, inputWidth));
      } else if (prompts.current.length) {
        const saved = recall.current;
        if (saved.index < 0 && key.downArrow) return;
        if (saved.index < 0 && key.upArrow) saved.saved = draftRef.current;
        saved.index = Math.max(-1, Math.min(prompts.current.length - 1, saved.index + (key.upArrow ? 1 : -1)));
        const text = prompts.current[prompts.current.length - 1 - saved.index];
        setDraft(saved.index < 0 ? saved.saved : {text, cursor: text.length});
      }
      return;
    }
    let action = key.leftArrow ? 'left' : key.rightArrow ? 'right'
      : key.home ? 'home' : key.end ? 'end' : key.backspace ? 'backspace' : key.delete ? 'delete' : null;
    if (key.ctrl) action = ({a: 'home', e: 'end', b: 'left', f: 'right', u: 'clear', w: 'wordBackspace', k: 'killEnd', d: 'delete'})[input];
    if (action) setDraft(editDraft(draftRef.current, action));
    else if (input && !key.ctrl && !key.meta) {
      const edited = editDraft(draftRef.current, 'insert', input);
      if (edited.text.length <= chatClient.MAX_MESSAGE_CHARACTERS) setDraft(edited);
      else setStatus(`Keep messages under ${chatClient.MAX_MESSAGE_CHARACTERS} characters.`);
    }
    recall.current.index = -1;
  });

  if (columns < 30 || rows < 10) {
    setCursorPosition(undefined);
    return h(Box, {width: columns, height: rows, flexDirection: 'column'},
      h(Text, styled(theme, {color: 'cyan'}), '›_ otekin'),
      h(Text, null, 'Resize to at least 30 × 10.'),
      h(Text, styled(theme, {dimColor: true}), 'Ctrl+C to exit')
    );
  }

  setCursorPosition(focus === 'composer' ? {
    x: 1 + sidebarWidth + 4 + layout.caret.column,
    y: rows - 1 - (draftRows + 2) + 1 + layout.caret.row - draftStart
  } : undefined);
  const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
  const currentStatus = busy ? `${SPINNER[tick % SPINNER.length]} ${status} · ${elapsed}s` : status;
  const title = view === 'profile' ? 'About Ömer' : view === 'help' ? 'Help & shortcuts' : 'Chat';
  return h(Box, {width: columns, height: rows, flexDirection: 'column', paddingX: 1},
    h(Box, {height: 1, justifyContent: 'space-between', flexShrink: 0},
      h(Box, null, h(Text, styled(theme, {bold: true, color: 'cyan'}), '›_ otekin '), h(Text, styled(theme, {dimColor: true}), '/ ', title)),
      h(Text, styled(theme, {dimColor: true}), `${busy ? 'WORKING' : '● READY'}  ·  v${version}`)
    ),
    h(Text, styled(theme, {dimColor: true}), '─'.repeat(Math.max(0, columns - 2))),
    h(Box, {height: rows - 3, flexShrink: 0},
      wide && h(Box, {width: sidebarWidth, flexShrink: 0, flexDirection: 'column', paddingTop: 1, paddingRight: 2},
        h(Text, styled(theme, {bold: true}), profile.name.toUpperCase()),
        h(Text, styled(theme, {dimColor: true}), wrapAnsi(profile.tagline, sidebarWidth - 2, {hard: true})),
        h(Text, null, ''),
        h(Text, styled(theme, {dimColor: true}), 'WORKSPACE'),
        ...NAVIGATION.map(([name, label], index) => h(Text, styled(theme, {
          key: name,
          color: (focus === 'navigation' ? nav === index : view === name) ? 'cyan' : undefined,
          bold: focus === 'navigation' && nav === index,
          inverse: focus === 'navigation' && nav === index
        }), `${(focus === 'navigation' ? nav === index : view === name) ? '›' : ' '} ${label}`)),
        h(Box, {flexGrow: 1}),
        h(Text, styled(theme, {dimColor: true}), 'Tab to navigate\n/ for commands')
      ),
      h(Box, {width: mainWidth, flexDirection: 'column'},
        h(Box, {height: viewportHeight, overflow: 'hidden', flexDirection: 'column', paddingX: 2, flexShrink: 0},
          view === 'chat' && !messages.length
            ? h(Welcome, {compact, theme})
            : h(Text, null, transcript.slice(firstLine, firstLine + viewportHeight).join('\n'))
        ),
        h(Box, {height: 1, paddingX: 1, justifyContent: 'space-between', flexShrink: 0},
          h(Text, styled(theme, {dimColor: !busy, color: busy ? 'cyan' : undefined, wrap: 'truncate-end'}), currentStatus),
          offset > 0 && h(Text, styled(theme, {color: 'yellow'}), ` ↑ ${offset} lines · PgDn ↓`)
        ),
        paletteRows > 0 && h(Box, {height: paletteRows, flexDirection: 'column', paddingX: 2, flexShrink: 0},
          ...matches.slice(commandStart, commandStart + paletteRows).map(([name, description], index) => h(Text, styled(theme, {
            key: name, color: index + commandStart === selectedCommand ? 'cyan' : undefined,
            dimColor: index + commandStart !== selectedCommand, wrap: 'truncate-end'
          }), `${index + commandStart === selectedCommand ? '›' : ' '} /${name.padEnd(11)} ${description}`))
        ),
        // Without color, a square border and a missing › show that the composer lost focus.
        h(Box, styled(theme, {height: draftRows + 2, borderStyle: theme.color || focus === 'composer' ? 'round' : 'single',
          borderColor: focus === 'composer' ? 'cyan' : 'gray', paddingX: 1, flexDirection: 'column', flexShrink: 0}),
          ...layout.lines.slice(draftStart, draftStart + draftRows).map((line, index) => h(Box, {key: index, height: 1, flexShrink: 0},
            h(Text, styled(theme, {color: 'cyan'}), index + draftStart === 0 && (theme.color || focus === 'composer') ? '› ' : '  '),
            h(Text, styled(theme, {dimColor: !draft.text, wrap: 'truncate-end'}), draft.text ? line : 'Ask anything, or type / for commands…')
          ))
        )
      )
    ),
    h(Text, styled(theme, {dimColor: true, wrap: 'truncate-end'}), columns < 65
      ? 'Enter send · / commands · Ctrl+C exit'
      : `Enter send · Ctrl+J newline · PgUp/PgDn scroll · ${busy ? 'Esc cancel' : 'Ctrl+C exit'}${wide ? ' · Tab navigate' : ''}`)
  );
}

export async function runTerminalApp(props) {
  const app = render(h(TerminalApp, props), {
    alternateScreen: true,
    exitOnCtrlC: false,
    incrementalRendering: true,
    kittyKeyboard: {mode: 'auto'},
    maxFps: 30
  });
  const stop = () => app.unmount();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);
  try {
    await app.waitUntilExit();
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGHUP', stop);
    app.unmount();
  }
}
