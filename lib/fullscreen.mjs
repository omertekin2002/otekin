import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, render, useApp, useCursor, useInput, usePaste, useWindowSize} from 'ink';
import wrapAnsi from 'wrap-ansi';
import chatClient from './chat-client.js';
import chatFormat from './chat-format.js';
import chatImages from './chat-images.js';
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
  ['clear', 'Start a fresh conversation'],
  ['exit', 'Return to your shell']
];
const NAVIGATION = [
  ['chat', 'Chat'], ['profile', 'About Ömer'], ['website', 'Website ↗'],
  ['linkedin', 'LinkedIn ↗'], ['cv', 'Résumé ↗'], ['help', 'Help & shortcuts']
];

function failureMessage(error) {
  const message = terminal.cleanText(error?.message || 'Chat request failed.');
  const id = typeof error?.requestId === 'string' ? error.requestId.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? `${message} (Request ID: ${id})` : message;
}

function toolLines(activities, theme) {
  return activities.map(activity => {
    const mark = activity.status === 'error' ? '!' : activity.status === 'running' ? '·' : '✓';
    const text = `${mark} ${terminal.activityLabel(activity, activity.status === 'running')}`;
    return activity.status === 'error' ? theme.warning(text + ' (failed)') : theme.muted(text);
  }).join('\n');
}

function Welcome({compact}) {
  return h(Box, {flexDirection: 'column', paddingX: compact ? 1 : 3, paddingTop: compact ? 0 : 2},
    h(Text, {color: 'cyan', bold: true}, '›_ otekin'),
    h(Text, {dimColor: true}, 'A little more personal. A lot more possible.'),
    h(Text, null, ''),
    h(Text, {bold: true}, "Hi, I'm Ömer Tekin."),
    h(Text, {dimColor: true}, 'Law & business student at Koç University.'),
    h(Text, null, ''),
    h(Text, null, 'Ask anything. Follow the research as it happens.'),
    h(Text, {dimColor: true}, 'Or type / to explore my work and find your way around.'),
    !compact && h(Text, null, '\nTry a conversation'),
    !compact && h(Text, {dimColor: true}, '  Explain a tricky concept\n  What happened in the world today?\n  Help me think through an idea')
  );
}

function Info({view, links}) {
  const lines = view === 'profile' ? [
    'Ömer Tekin', '', 'Law & business student at Koç University.', '',
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
    'Ctrl+D             Exit with an empty draft', '',
    ...COMMANDS.map(([name, description]) => `/${name.padEnd(17)} ${description}`)
  ];
  return lines.join('\n');
}

export function TerminalApp({links, version, options = {}, openInBrowser, services = chatClient}) {
  const {exit} = useApp();
  const {setCursorPosition} = useCursor();
  const {columns, rows} = useWindowSize();
  const theme = useMemo(() => terminal.createTheme({isTTY: true}), []);
  const [draft, setDraftState] = useState(EMPTY_DRAFT);
  const draftRef = useRef(EMPTY_DRAFT);
  const history = useRef([]);
  const prompts = useRef([]);
  const recall = useRef({index: -1, saved: EMPTY_DRAFT});
  const active = useRef(null);
  const mounted = useRef(true);
  const [messages, setMessages] = useState([]);
  const [activities, setActivities] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready when you are');
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
  const cancel = () => {
    if (active.current) active.current.abort();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick(value => value + 1), 100);
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
      cancel();
      history.current = [];
      setMessages([]);
      setActivities([]);
      setView('chat');
      setStatus('Conversation cleared');
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
    const prompt = text.trim();
    if (!prompt) return;
    if (prompt.startsWith('/')) {
      setDraft(EMPTY_DRAFT);
      await runCommand(prompt.slice(1).toLowerCase());
      return;
    }
    if (active.current) {
      setStatus('A reply is on the way. Esc cancels it; your draft is saved.');
      return;
    }
    let candidate;
    try {
      candidate = services.prepareRequestMessages(history.current, prompt);
    } catch (error) {
      setStatus(failureMessage(error));
      return;
    }
    setDraft(EMPTY_DRAFT);
    recall.current.index = -1;
    prompts.current = prompts.current.concat(prompt).slice(-50);
    setView('chat');
    setScroll(0);
    append({role: 'user', content: prompt});
    const controller = new AbortController();
    active.current = controller;
    startedAt.current = Date.now();
    setBusy(true);
    setActivities([]);
    setStatus('Connecting to chat service');
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
      const response = await services.requestChat(candidate, {signal: controller.signal, onActivity});
      if (!mounted.current || controller.signal.aborted) return;
      if (Array.isArray(response.toolActivity)) response.toolActivity.forEach(onActivity);
      const saved = chatImages.saveGeneratedImages(response);
      append(
        ...(tools.size ? [{role: 'tools', content: toolLines([...tools.values()], theme)}] : []),
        {role: 'assistant', content: chatFormat.formatChatResponse(saved, {hyperlinks: true, color: theme.color})}
      );
      history.current = candidate.concat(services.assistantMessageFromResponse(response));
      setStatus('Ready when you are');
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        append({role: 'error', content: failureMessage(error)});
        setStatus('Try again when you’re ready');
      }
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) {
        setBusy(false);
        setActivities([]);
        if (controller.signal.aborted) setStatus('Cancelled. Ready for your next message.');
      }
    }
  }

  const transcript = useMemo(() => {
    let content;
    if (view !== 'chat') content = Info({view, links});
    else content = messages.map(message => {
      if (message.role === 'tools') return message.content + '\n';
      const label = message.role === 'user' ? theme.accent(theme.strong('YOU'))
        : message.role === 'assistant' ? theme.strong('OTEKIN')
          : message.role === 'error' ? theme.warning('! CHAT ERROR') : theme.muted('•');
      return `${label}\n${message.content}\n`;
    }).join('\n');
    if (view === 'chat' && activities.length) content += '\n' + toolLines(activities, theme);
    return wrapAnsi(content, Math.max(2, mainWidth - 4), {hard: true, trim: false}).split('\n');
  }, [messages, activities, view, links, theme, mainWidth]);
  const maxScroll = Math.max(0, transcript.length - viewportHeight);
  const offset = Math.min(scroll, maxScroll);
  const firstLine = view === 'chat' ? maxScroll - offset : offset;

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
      else { setDraft({text: '/', cursor: 1}); setFocus('composer'); }
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
      h(Text, {color: 'cyan'}, '›_ otekin'),
      h(Text, null, 'Resize to at least 30 × 10.'),
      h(Text, {dimColor: true}, 'Ctrl+C to exit')
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
      h(Text, {bold: true, color: 'cyan'}, '›_ otekin ', h(Text, {dimColor: true, bold: false, color: 'white'}, '/ ', title)),
      h(Text, {dimColor: true}, `${busy ? 'WORKING' : '● READY'}  ·  v${version}`)
    ),
    h(Text, {dimColor: true}, '─'.repeat(Math.max(0, columns - 2))),
    h(Box, {height: rows - 3, flexShrink: 0},
      wide && h(Box, {width: sidebarWidth, flexShrink: 0, flexDirection: 'column', paddingTop: 1, paddingRight: 2},
        h(Text, {bold: true}, 'ÖMER TEKIN'),
        h(Text, {dimColor: true}, 'Law × business'),
        h(Text, {dimColor: true}, 'Koç University'),
        h(Text, null, ''),
        h(Text, {dimColor: true}, 'WORKSPACE'),
        ...NAVIGATION.map(([name, label], index) => h(Text, {
          key: name,
          color: (focus === 'navigation' ? nav === index : view === name) ? 'cyan' : undefined,
          bold: focus === 'navigation' && nav === index,
          inverse: focus === 'navigation' && nav === index
        }, `${(focus === 'navigation' ? nav === index : view === name) ? '›' : ' '} ${label}`)),
        h(Box, {flexGrow: 1}),
        h(Text, {dimColor: true}, 'Tab to navigate\n/ for commands')
      ),
      h(Box, {width: mainWidth, flexDirection: 'column'},
        h(Box, {height: viewportHeight, overflow: 'hidden', flexDirection: 'column', paddingX: 2, flexShrink: 0},
          view === 'chat' && !messages.length
            ? h(Welcome, {compact})
            : h(Text, null, transcript.slice(firstLine, firstLine + viewportHeight).join('\n'))
        ),
        h(Box, {height: 1, paddingX: 1, justifyContent: 'space-between', flexShrink: 0},
          h(Text, {dimColor: !busy, color: busy ? 'cyan' : undefined, wrap: 'truncate-end'}, currentStatus),
          offset > 0 && h(Text, {color: 'yellow'}, ` ↑ ${offset} lines · PgDn ↓`)
        ),
        paletteRows > 0 && h(Box, {height: paletteRows, flexDirection: 'column', paddingX: 2, flexShrink: 0},
          ...matches.slice(commandStart, commandStart + paletteRows).map(([name, description], index) => h(Text, {
            key: name, color: index + commandStart === selectedCommand ? 'cyan' : undefined,
            dimColor: index + commandStart !== selectedCommand, wrap: 'truncate-end'
          }, `${index + commandStart === selectedCommand ? '›' : ' '} /${name.padEnd(11)} ${description}`))
        ),
        h(Box, {height: draftRows + 2, borderStyle: 'round', borderColor: focus === 'composer' ? 'cyan' : 'gray', paddingX: 1, flexDirection: 'column', flexShrink: 0},
          ...layout.lines.slice(draftStart, draftStart + draftRows).map((line, index) => h(Box, {key: index, height: 1, flexShrink: 0},
            h(Text, {color: 'cyan'}, index + draftStart === 0 ? '› ' : '  '),
            h(Text, {dimColor: !draft.text, wrap: 'truncate-end'}, draft.text ? line : 'Ask anything, or type / for commands…')
          ))
        )
      )
    ),
    h(Text, {dimColor: true, wrap: 'truncate-end'}, columns < 65
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
