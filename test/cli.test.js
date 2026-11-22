'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { Terminal } = require('@xterm/headless');
const pkg = require('../package.json');
const chatHistory = require('../lib/chat-history');
const { startDownGateway } = require('./down-gateway');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'otekin.js');
const GREETING = "Hi, I'm Ömer Tekin.";
const TAGLINE = 'Law & business student at Koç University.';
const TTY_STDOUT = ['-r', path.join(__dirname, 'tty-stdout.js')];
const TTY_STDIN = ['-r', path.join(__dirname, 'tty-stdin.js')];
const SGR = /\u001b\[[0-9;]*m/;
// Cursor movement, erase and alternate-screen sequences, plus any carriage return.
const REDRAW = /\u001b\[[0-9;?]*[A-HJK]|\u001b\[\?1049|\r/;

// `nodeArgs` such as `-r <preload>` go before the CLI; an `undefined` env value unsets it.
// `input` is written to the CLI's stdin before it is closed. `cwd` defaults to the repository.
function runCli(args, env, nodeArgs, input, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const childEnv = Object.assign({}, process.env, {
      OTEKIN_CHAT_API_URL: 'http://127.0.0.1:1/v1/chat',
      OTEKIN_CHAT_HEALTH_URL: ''
    }, env || {});
    Object.keys(childEnv).forEach((key) => {
      if (childEnv[key] === undefined) delete childEnv[key];
    });
    const child = spawn(process.execPath, (nodeArgs || []).concat(CLI, args), {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, 5000);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
    child.stdin.end(input || '');
  });
}

function listen(handler, healthHandler) {
  return new Promise((resolve, reject) => {
    let handlerError = null;
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentLength: request.headers['content-length']
      });

      Promise.resolve().then(() => {
        if (request.method === 'GET' && request.url === '/healthz') {
          if (healthHandler) return healthHandler(request, response);
          request.resume();
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: true, service: 'fixture' }));
          return;
        }
        return handler(request, response);
      }).catch((error) => {
        handlerError = error;
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        // A TCP server always reports an AddressInfo, never a pipe path.
        endpoint: `http://127.0.0.1:${/** @type {import('net').AddressInfo} */ (server.address()).port}/v1/chat`,
        getHandlerError: () => handlerError,
        getRequests: () => requests.slice()
      });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withServer(handler, run, healthHandler) {
  const fixture = await listen(handler, healthHandler);
  try {
    await run(fixture.endpoint, fixture);
    if (fixture.getHandlerError()) throw fixture.getHandlerError();
  } finally {
    await close(fixture.server);
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

test('CLI help and version include chat without changing version behavior', async () => {
  const help = await runCli(['--help']);
  assert.strictEqual(help.code, 0);
  assert.match(help.stdout, /otekin chat/);
  assert.match(help.stdout, /otekin pilcrow/);
  assert.match(help.stdout, /\/clear/);
  assert.match(help.stdout, /\/retry\s+Send your last message again/);
  assert.match(help.stdout, /\/save\s+Save the conversation as a Markdown file/);
  assert.match(help.stdout, /\/sources\s+Show the full titles and links of a reply's sources/);
  assert.match(help.stdout, /one-shot chat shows the reply as it streams in/);
  assert.match(help.stdout, /exits with code 130/);
  assert.doesNotMatch(help.stdout, /--research/);
  assert.match(help.stdout, /otekin chat -- "-5°C in °F\?"/);
  assert.match(help.stdout, /--no-history/);
  assert.match(help.stdout, /OTEKIN_NO_HISTORY=1/);
  assert.match(help.stdout, /OTEKIN_HISTORY_FILE/);
  assert.doesNotMatch(help.stdout, /memory only|current session/i);
  assert.strictEqual(help.stderr, '');

  const version = await runCli(['--version']);
  assert.strictEqual(version.code, 0);
  assert.strictEqual(version.stdout, `${pkg.version}\n`);
  assert.strictEqual(version.stderr, '');
});

test('Pilcrow CLI dispatches installation and upgrade without entering chat', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-pilcrow-cli-'));
  const preload = path.join(directory, 'installer.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(ROOT, 'lib/install-pilcrow.js'))}).installPilcrow = async (opts) => {
    if (process.env.TEST_INSTALL_FAILURE) throw Object.assign(new Error('fixture failure'), { exitCode: 7 });
    process.stdout.write('INSTALL:' + JSON.stringify(opts) + '\\n');
  };`);
  const invoke = (args, env) => runCli(args, env, ['-r', preload]);
  try {
    const install = await invoke(['pilcrow']);
    assert.strictEqual(install.code, 0);
    assert.strictEqual(install.stdout, 'INSTALL:{"upgrade":false,"nonInteractive":false}\n');
    const upgrade = await invoke(['pilcrow', '--upgrade', '--non-interactive']);
    assert.strictEqual(upgrade.code, 0);
    assert.strictEqual(upgrade.stdout, 'INSTALL:{"upgrade":true,"nonInteractive":true}\n');
    const help = await invoke(['pilcrow', '--help']);
    assert.strictEqual(help.code, 0);
    assert.match(help.stdout, /Usage: npx otekin pilcrow/);
    assert.doesNotMatch(help.stdout, /INSTALL:/);
    const version = await invoke(['pilcrow', '--version']);
    assert.strictEqual(version.stdout, pkg.version + '\n');
    for (const args of [['pilcrow', 'export'], ['pilcrow', '--json'], ['--json', 'pilcrow'],
      ['pilcrow', '--no-open'], ['pilcrow', '--no-history'], ['pilcrow', '--cv'], ['pilcrow', '--reduced-motion'],
      ['pilcrow', '--unknown'], ['pilcrow', '--', '--upgrade'], ['--upgrade']]) {
      const result = await invoke(args);
      assert.strictEqual(result.code, 1, args.join(' '));
      assert.doesNotMatch(result.stdout, /INSTALL:/);
    }
    const rejected = await invoke(['pilcrow', '--reduced-motion']);
    assert.match(rejected.stderr, /^Pilcrow installation accepts only --upgrade, --help, --version, and --non-interactive\./);
    // The environment variable is a preference, not an option, so it never blocks installation.
    const preference = await invoke(['pilcrow'], { OTEKIN_REDUCED_MOTION: '1' });
    assert.strictEqual(preference.code, 0);
    assert.match(preference.stdout, /^INSTALL:/);
    const failure = await invoke(['pilcrow'], { TEST_INSTALL_FAILURE: '1' });
    assert.strictEqual(failure.code, 7);
    assert.match(failure.stderr, /Pilcrow installation failed: fixture failure/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI preserves bare profile JSON output', async () => {
  const result = await runCli(['--json']);
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stdout, JSON.stringify(JSON.parse(result.stdout), null, 2) + '\n');
  assert.deepStrictEqual(JSON.parse(result.stdout), {
    message: `${GREETING} ${TAGLINE}`,
    links: {
      website: 'https://omertekin2002.github.io',
      linkedin: 'https://www.linkedin.com/in/ömer-tekin/',
      cv: 'https://omertekin2002.github.io/resume'
    }
  });
  assert.strictEqual(result.stderr, '');
});

test('CLI preserves profile, CV, and LinkedIn commands', async () => {
  const profile = await runCli([]);
  assert.strictEqual(profile.code, 0);
  assert.strictEqual(profile.stdout, [
    GREETING,
    TAGLINE,
    '',
    'Links:',
    '- Website: https://omertekin2002.github.io',
    '- LinkedIn: https://www.linkedin.com/in/ömer-tekin/',
    '- CV: https://omertekin2002.github.io/resume',
    ''
  ].join('\n'));
  assert.strictEqual(profile.stderr, '');

  const nonInteractive = await runCli(['--non-interactive']);
  assert.strictEqual(nonInteractive.code, 0);
  assert.strictEqual(nonInteractive.stdout, profile.stdout);

  const cv = await runCli(['cv', '--no-open']);
  assert.strictEqual(cv.code, 0);
  assert.match(cv.stdout, /Link: https:\/\/omertekin2002\.github\.io\/resume/);

  const linkedin = await runCli(['linkedin', '--no-open']);
  assert.strictEqual(linkedin.code, 0);
  assert.match(linkedin.stdout, /Link: https:\/\/www\.linkedin\.com/);
});

test('CLI preserves readable unknown command behavior', async () => {
  const result = await runCli(['unknown-command']);
  assert.strictEqual(result.code, 1);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stderr, /Unknown option: unknown-command/);
});

test('CLI one-shot chat sends the joined prompt and prints only the answer', async () => {
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    assert.strictEqual(request.url, '/v1/chat');
    assert.deepStrictEqual(body, {
      messages: [{ role: 'user', content: 'explain this contract' }],
      stream: false
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'A concise answer.\n\n', provider: 'fixture' }));
  }, async (endpoint, fixture) => {
    const result = await runCli(['chat', 'explain', 'this', 'contract'], {
      OTEKIN_CHAT_API_URL: endpoint
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, 'A concise answer.\n');
    assert.strictEqual(result.stderr, '');
    assert.doesNotMatch(result.stdout, /Hi, I'm Ömer|Koç University/);
    const requests = fixture.getRequests();
    assert.deepStrictEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      ['GET /healthz', 'POST /v1/chat']
    );
    assert.strictEqual(requests[0].authorization, undefined);
    assert.strictEqual(requests[0].contentLength, undefined);
    assert.strictEqual(requests[1].authorization, undefined);
    assert(Number(requests[1].contentLength) > 0);
  });
});

test('CLI rejects unknown options without sending anything', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Should not be reached.' }));
  }, async (endpoint, fixture) => {
    for (const [args, name] of /** @type {Array<[string[], string]>} */ ([
      [['--reserch'], '--reserch'],
      [['chat', 'Find', 'sources', '--research', 'always'], '--research'],
      [['chat', 'Find', '--research=never'], '--research'],
      [['chat', '-x', 'hi'], '-x'],
      [['chat', 'hi', '--reserch'], '--reserch'],
      [['--research=secret', 'chat', 'hi'], '--research'],
      [['--help', '--unknown-flag'], '--unknown-flag'],
      [['--json', 'chat', 'hi', '--unknown-flag', '--select'], '--unknown-flag']
    ])) {
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint });
      assert.strictEqual(result.code, 1, args.join(' '));
      assert.strictEqual(result.stdout, '', args.join(' '));
      assert.strictEqual(
        result.stderr,
        `Unknown option: ${name}\n` +
          `Run "otekin --help" to see the options. To send text that starts with "-", put it after "--": otekin chat -- "${name}"\n`,
        args.join(' ')
      );
      assert.doesNotMatch(result.stderr, /secret|never|Usage:/);
    }
    assert.deepStrictEqual(fixture.getRequests(), []);
  });

  const control = await runCli(['chat', 'hi', '--bad\u001B[31m']);
  assert.strictEqual(control.code, 1);
  assert.doesNotMatch(control.stderr, /\u001B/);
  assert.match(control.stderr, /^Unknown option: --bad\n/);
});

test('CLI sends option-like words after -- as the prompt', async () => {
  const bodies = [];
  await withServer(async (request, response) => {
    bodies.push(JSON.parse(await readBody(request)));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Answer.' }));
  }, async (endpoint) => {
    for (const args of [['chat', '--', '--research', 'always'], ['chat', '--', '--reserch', 'hi']]) {
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint });
      assert.strictEqual(result.code, 0, args.join(' '));
      assert.strictEqual(result.stdout, 'Answer.\n');
      assert.strictEqual(result.stderr, '');
    }
  });

  assert.deepStrictEqual(bodies.map((body) => body.messages[0].content), ['--research always', '--reserch hi']);
});

test('CLI accepts every known option', async () => {
  for (const args of [['-h'], ['--help']]) {
    const result = await runCli(args);
    assert.strictEqual(result.code, 0, args.join(' '));
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /rejected as\s+unknown options unless they come after --/);
    assert.doesNotMatch(result.stdout, /ignored/);
    assert.strictEqual(result.stderr, '');
  }

  for (const args of [['-v'], ['--version']]) {
    const result = await runCli(args);
    assert.strictEqual(result.code, 0, args.join(' '));
    assert.strictEqual(result.stdout, `${pkg.version}\n`);
  }

  for (const args of [['--non-interactive'], ['--no-interactive'], ['--no-history', '--non-interactive'],
    ['--reduced-motion', '--non-interactive']]) {
    const result = await runCli(args);
    assert.strictEqual(result.code, 0, args.join(' '));
    assert.match(result.stdout, /Links:/);
    assert.strictEqual(result.stderr, '');
  }

  for (const args of [['--cv', '--no-open'], ['--resume', '--no-open'], ['cv', '--no-open', '--reduced-motion'], ['-s', 'cv', '--no-open'], ['--select', 'cv', '--no-open'], ['--select=cv', '--no-open']]) {
    const result = await runCli(args);
    assert.strictEqual(result.code, 0, args.join(' '));
    assert.match(result.stdout, /Link: https:\/\/omertekin2002\.github\.io\/resume/);
    assert.strictEqual(result.stderr, '');
  }
});

test('CLI sends dash-leading prompts and treats arguments after -- as positional', async () => {
  const bodies = [];
  await withServer(async (request, response) => {
    bodies.push(JSON.parse(await readBody(request)));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Answer.' }));
  }, async (endpoint) => {
    for (const args of [
      ['chat', '-5°C in °F?'],
      ['chat', '-', 'bullet', '--- x', '--a b=c'],
      ['chat', '--', '--help', 'me'],
      ['chat', 'Explain', '--', '--select', '-h', '--'],
      ['chat', 'Explain this', '--no-open']
    ]) {
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint });
      assert.strictEqual(result.code, 0, args.join(' '));
      assert.strictEqual(result.stdout, 'Answer.\n');
      assert.strictEqual(result.stderr, '');
    }
  });

  assert.deepStrictEqual(bodies.map((body) => body.messages[0].content), [
    '-5°C in °F?',
    '- bullet --- x --a b=c',
    '--help me',
    'Explain --select -h --',
    'Explain this'
  ]);
  assert.deepStrictEqual(bodies[0], {
    messages: [{ role: 'user', content: '-5°C in °F?' }],
    stream: false
  });
});

test('CLI parses options before -- and keeps options after prompt words', async () => {
  const gatewayResponse = { message: 'JSON answer', provider: 'fixture' };
  const bodies = [];
  await withServer(async (request, response) => {
    bodies.push(JSON.parse(await readBody(request)));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(gatewayResponse));
  }, async (endpoint) => {
    for (const args of [['--json', 'chat', '--', '-v'], ['chat', 'Explain this', '--json']]) {
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint });
      assert.strictEqual(result.code, 0);
      assert.deepStrictEqual(JSON.parse(result.stdout), gatewayResponse);
      assert.strictEqual(result.stderr, '');
    }
  });
  assert.deepStrictEqual(bodies.map((body) => body.messages[0].content), ['-v', 'Explain this']);

  const cv = await runCli(['--no-open', '--', 'cv']);
  assert.strictEqual(cv.code, 0);
  assert.match(cv.stdout, /Link: https:\/\/omertekin2002\.github\.io\/resume/);
  assert.strictEqual(cv.stderr, '');
});

test('CLI rejects --select without a value', async () => {
  for (const args of [['--select'], ['--select', '--'], ['-s'], ['--select='], ['--select', '--', 'cv']]) {
    const result = await runCli(args);
    assert.strictEqual(result.code, 1, args.join(' '));
    assert.strictEqual(result.stdout, '');
    assert.match(result.stderr, /^Missing value for --select\n/);
    assert.match(result.stderr, /Usage:/);
  }

  const valid = await runCli(['--select=linkedin', '--no-open']);
  assert.strictEqual(valid.code, 0);
  assert.match(valid.stdout, /Link: https:\/\/www\.linkedin\.com/);
});

test('CLI one-shot --json preserves the complete gateway response', async () => {
  const gatewayResponse = {
    message: 'JSON answer',
    provider: 'fixture',
    model: 'fixture-model',
    webSearchQuery: 'fixture query',
    webSources: [{ url: 'https://example.com' }],
    toolActivity: [{ id: 'search', tool: 'search_web', query: 'fixture query', status: 'complete' }]
  };

  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(gatewayResponse));
  }, async (endpoint) => {
    const result = await runCli(['--json', 'chat', 'Question'], {
      OTEKIN_CHAT_API_URL: endpoint
    });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), gatewayResponse);
    assert.strictEqual(result.stderr, '');
  });
});

test('CLI one-shot --json escapes C1 and bidi controls in the reply, sources and URLs', async () => {
  const controls = '\u009B2J\u009D0;owned\u0007\u0085\u007F\u202E';
  const gatewayResponse = {
    message: `Answer ${controls} end`,
    provider: 'fixture',
    webSources: [{ title: `Title ${controls}`, url: `https://example.com/${controls}` }]
  };

  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(gatewayResponse));
  }, async (endpoint) => {
    const result = await runCli(['--json', 'chat', 'Question'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, '');
    assert.doesNotMatch(result.stdout, /[\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    for (const escape of ['\\u009b', '\\u009d', '\\u0085', '\\u007f', '\\u202e']) {
      assert.strictEqual(result.stdout.split(escape).length - 1, 3, escape);
    }
    assert.deepStrictEqual(JSON.parse(result.stdout), gatewayResponse);

    // Printed to a terminal, the output changes neither the title nor the screen.
    const emulator = new Terminal({ cols: 200, rows: 20, convertEol: true, allowProposedApi: true, scrollback: 0 });
    let title = null;
    emulator.onTitleChange((value) => { title = value; });
    await new Promise((resolve) => emulator.write('before\n', () => resolve(undefined)));
    await new Promise((resolve) => emulator.write(result.stdout, () => resolve(undefined)));
    const buffer = emulator.buffer.active;
    const screen = Array.from({ length: buffer.length }, (_, index) =>
      buffer.getLine(index).translateToString(true)).join('\n');
    emulator.dispose();
    assert.strictEqual(title, null);
    assert.match(screen, /^before\n\{/);
    assert.match(screen, /"message": "Answer \\u009b2J\\u009d0;owned\\u0007\\u0085\\u007f\\u202e end"/);
  });
});

test('CLI one-shot --json output is byte-identical to JSON.stringify without control characters', async () => {
  const gatewayResponse = { message: 'Ömer · Koç 界 \u{1F469}\u200D\u{1F4BB}', webSources: [{ title: 'T', url: 'https://e.test' }] };
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(gatewayResponse));
  }, async (endpoint) => {
    const result = await runCli(['--json', 'chat', 'Question'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, JSON.stringify(gatewayResponse, null, 2) + '\n');
  });
});

test('CLI compacts researched source links in ordinary output', async () => {
  const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/very-long-token';
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      message: `Answer with a citation [1].\n\nSources:\n1. [example.com](<${redirect}>)`,
      webSources: [{ title: 'example.com', url: redirect, snippet: 'Supporting evidence.' }]
    }));
  }, async (endpoint) => {
    const result = await runCli(['chat', 'Question'], {
      OTEKIN_CHAT_API_URL: endpoint
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, 'Answer with a citation [1].\n\nSources: [1] example.com\n');
    assert.doesNotMatch(result.stdout, /vertexaisearch/);
    assert.strictEqual(result.stderr, '');
  });
});

test('CLI one-shot chat prints the answer and sources without bidi overrides or zero-width characters', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      message: 'Answer \u202egnp.exe\u202c\u200b [1].\n\nSources:\n1. [Title \u2067evil\u2069\ufeff](https://example.com/a)',
      webSources: [{ title: 'Title \u2067evil\u2069\ufeff', url: 'https://example.com/a' }]
    }));
  }, async (endpoint) => {
    const result = await runCli(['chat', 'Question'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, 'Answer gnp.exe [1].\n\nSources: [1] Title evil\n');
    assert.strictEqual(result.stderr, '');
  });
});

test('CLI chat failures show safe categories and request IDs while hiding response bodies', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(502, {
      'Content-Type': 'application/json',
      'X-Request-ID': 'gateway-request-123'
    });
    response.end(JSON.stringify({
      error: 'secret internal failure detail',
      code: 'generation_unavailable'
    }));
  }, async (endpoint, fixture) => {
    const posts = () => fixture.getRequests().filter((request) => request.method === 'POST').length;
    const result = await runCli(['chat', 'Question'], {
      OTEKIN_CHAT_API_URL: endpoint
    });
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.stdout, '');
    assert.match(result.stderr, /chat generation is temporarily unavailable/i);
    assert.match(result.stderr, /Request ID: gateway-request-123/);
    assert.doesNotMatch(result.stderr, /--research/);
    assert.doesNotMatch(result.stderr, /secret internal failure detail/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    // The question reached the gateway: never "not sent", and no /retry hint without a composer.
    assert.strictEqual(result.stderr, 'Chat error: Chat generation is temporarily unavailable. Try again later. ' +
      '(Request ID: gateway-request-123) The chat service may have received your question.\n');
    assert.strictEqual(posts(), 1);

    const json = await runCli(['--json', 'chat', 'Question'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(json.code, 1);
    assert.strictEqual(json.stdout, '');
    assert.strictEqual(json.stderr, result.stderr);
    assert.strictEqual(posts(), 2);
  });
});

test('CLI does not send conversation data when the health check fails', async () => {
  let chatRequests = 0;
  await withServer((request, response) => {
    chatRequests += 1;
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Should not be reached.' }));
  }, async (endpoint, fixture) => {
    const result = await runCli(['chat', 'Private question'], {
      OTEKIN_CHAT_API_URL: endpoint
    });
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.stdout, '');
    assert.match(result.stderr, /health check failed/i);
    // One-shot chat says the question never left, without a /retry hint it has no composer for.
    assert.strictEqual(result.stderr, 'Chat error: Chat service health check failed (HTTP 500). Your question was not sent.\n');
    assert.strictEqual(chatRequests, 0);
    assert.deepStrictEqual(
      fixture.getRequests().map((request) => `${request.method} ${request.url}`),
      ['GET /healthz']
    );

    const json = await runCli(['--json', 'chat', 'Private question'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(json.code, 1);
    assert.strictEqual(json.stdout, '');
    assert.strictEqual(json.stderr, result.stderr);
    assert.strictEqual(chatRequests, 0);
  }, (request, response) => {
    request.resume();
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'unavailable' }));
  });
});

test('CLI rejects promptless non-TTY and promptless JSON chat locally', async () => {
  const nonTty = await runCli(['chat']);
  assert.strictEqual(nonTty.code, 1);
  assert.strictEqual(nonTty.stdout, '');
  assert.match(nonTty.stderr, /requires a prompt/i);

  const json = await runCli(['chat', '--json']);
  assert.strictEqual(json.code, 1);
  assert.strictEqual(json.stdout, '');
  assert.match(json.stderr, /does not support --json/i);
});

test('CLI one-shot, --json and piped runs never create the history file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-cli-history-'));
  const file = path.join(directory, 'state', 'history.json');
  try {
    await withServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'Answer.' }));
    }, async (endpoint) => {
      for (const args of [
        ['chat', 'Question'],
        ['--json', 'chat', 'Question'],
        ['chat', 'Question', '--no-history'],
        ['chat'],
        ['--select', 'chat'],
        []
      ]) {
        const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint, OTEKIN_HISTORY_FILE: file });
        assert.notStrictEqual(result.signal, 'SIGTERM', args.join(' '));
        assert.strictEqual(fs.existsSync(path.dirname(file)), false, args.join(' '));
      }
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Runs a one-shot chat whose stdout claims to be a 60x15 terminal, and replays it in xterm.
async function runTtyChat(args, env) {
  const result = await runCli(args, Object.assign({ TERM: 'xterm-256color', NO_COLOR: undefined }, env), TTY_STDOUT);
  const emulator = new Terminal({ cols: 60, rows: 15, convertEol: true, allowProposedApi: true, scrollback: 0 });
  await new Promise((resolve) => emulator.write(result.stdout, () => resolve(undefined)));
  const buffer = emulator.buffer.active;
  result.screen = Array.from({ length: 15 }, (_, index) =>
    buffer.getLine(buffer.viewportY + index).translateToString(true)).join('\n').replace(/\s+$/, '');
  emulator.dispose();
  return result;
}

function streamReply(events) {
  return async (request, response) => {
    const body = JSON.parse(await readBody(request));
    assert.strictEqual(body.stream, true);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const event of events) {
      if (typeof event === 'number') await new Promise((resolve) => setTimeout(resolve, event));
      else response.write(JSON.stringify(event) + '\n');
    }
    response.end();
  };
}

test('CLI one-shot chat on a terminal streams a preview, then prints only the canonical answer', async () => {
  await withServer(streamReply([
    { type: 'delta', text: 'Provisional \u001b]52;c;ZXZpbA==\u0007text' },
    250,
    { type: 'delta', text: ' and \u001b[31mmore\u001b[0m' },
    250,
    { type: 'done', message: 'Canonical answer.' }
  ]), async (endpoint) => {
    const result = await runTtyChat(['chat', 'hi'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, '');
    const provisional = result.stdout.indexOf('Provisional text and more');
    assert(provisional >= 0 && provisional < result.stdout.indexOf('Canonical answer.'));
    assert.doesNotMatch(result.stdout, /\u001b\]52|ZXZpbA|\u001b\[31m/);
    // After the erase, the bytes are exactly what a terminal got before streaming.
    assert(result.stdout.endsWith('\u001b[?25h\n\u001b[1m  AI\u001b[0m\n\nCanonical answer.\n\n'));
    assert.strictEqual(result.screen, '\n  AI\n\nCanonical answer.');
  });
});

test('CLI one-shot preview is erased when the stream fails or ends early', async () => {
  for (const ending of [[], [{ type: 'error', error: 'raw provider failure' }]]) {
    await withServer(streamReply([{ type: 'delta', text: 'Half an answer' }, 250, ...ending]), async (endpoint) => {
      const result = await runTtyChat(['chat', 'hi'], { OTEKIN_CHAT_API_URL: endpoint });
      assert.strictEqual(result.code, 1);
      assert.match(result.stdout, /Half an answer/);
      assert.match(result.stderr, /^Chat error: /);
      assert.doesNotMatch(result.stderr, /raw provider failure/);
      assert.strictEqual(result.screen, '');
      assert.match(result.stdout, /\u001b\[\?25h$/);
    });
  }
});

test('CLI one-shot preview follows NO_COLOR', async () => {
  await withServer(streamReply([{ type: 'delta', text: 'Plain preview' }, 250, { type: 'done', message: '**Plain** answer.' }]),
    async (endpoint) => {
      const result = await runTtyChat(['chat', 'hi'], { OTEKIN_CHAT_API_URL: endpoint, NO_COLOR: '1' });
      assert.strictEqual(result.code, 0);
      assert.match(result.stdout, /Plain preview/);
      assert.doesNotMatch(result.stdout, SGR);
      assert.strictEqual(result.screen, '\n  AI\n\n**Plain** answer.');
    });
});

const MOTION = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\d+s\b/;

test('CLI one-shot --reduced-motion streams a still preview, with the flag or OTEKIN_REDUCED_MOTION', async () => {
  const events = [
    { type: 'tool', activity: { id: 's', tool: 'search_web', query: 'still', status: 'running' } },
    { type: 'delta', text: 'Still provisional' },
    1300,
    { type: 'tool', activity: { id: 's', tool: 'search_web', query: 'still', status: 'complete' } },
    { type: 'done', message: 'Still answer.' }
  ];
  for (const [args, env] of [[['chat', 'hi', '--reduced-motion'], {}], [['chat', 'hi'], { OTEKIN_REDUCED_MOTION: '1' }]]) {
    await withServer(streamReply(events), async (endpoint) => {
      const result = await runTtyChat(args, { OTEKIN_CHAT_API_URL: endpoint, ...env });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.strictEqual(result.stderr, '');
      const provisional = result.stdout.indexOf('Still provisional');
      assert(provisional >= 0 && provisional < result.stdout.indexOf('Still answer.'));
      // Over a second with no new text or label: the status row is written once, never ticked.
      assert.strictEqual(result.stdout.split('… Writing').length - 1, 1);
      assert.doesNotMatch(result.stdout, MOTION);
      assert.strictEqual(result.screen, '\n  AI\n\nStill answer.');
    });
  }
  // Without it, the same reply ticks its spinner and seconds counter.
  await withServer(streamReply(events), async (endpoint) => {
    const result = await runTtyChat(['chat', 'hi'], { OTEKIN_CHAT_API_URL: endpoint, OTEKIN_REDUCED_MOTION: '0' });
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Writing · 1s/);
  });
});

test('CLI --reduced-motion leaves piped and --json one-shot output unchanged', async () => {
  await withServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'A concise answer.', provider: 'fixture' }));
  }, async (endpoint) => {
    const piped = await runCli(['chat', 'hi', '--reduced-motion'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(piped.code, 0);
    assert.strictEqual(piped.stdout, 'A concise answer.\n');
    const json = await runTtyChat(['chat', 'hi', '--json', '--reduced-motion'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.deepStrictEqual(JSON.parse(json.stdout), { message: 'A concise answer.', provider: 'fixture' });
    assert.strictEqual(piped.stderr + json.stderr, '');
  });
});

test('CLI one-shot on a dumb terminal or with --json keeps the non-streaming output', async () => {
  const bodies = [];
  await withServer(async (request, response) => {
    bodies.push(JSON.parse(await readBody(request)));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'A concise answer.\n\n', provider: 'fixture' }));
  }, async (endpoint) => {
    const dumb = await runTtyChat(['chat', 'hi'], { OTEKIN_CHAT_API_URL: endpoint, TERM: 'dumb' });
    assert.strictEqual(dumb.code, 0);
    assert.strictEqual(dumb.stdout, 'A concise answer.\n');
    const json = await runTtyChat(['chat', 'hi', '--json'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(json.code, 0);
    assert.deepStrictEqual(JSON.parse(json.stdout), { message: 'A concise answer.\n\n', provider: 'fixture' });
    assert.strictEqual(dumb.stderr + json.stderr, '');
  });
  assert.deepStrictEqual(bodies.map((body) => body.stream), [false, false]);
});

function linearGateway(bodies, reply) {
  return async (request, response) => {
    const body = JSON.parse(await readBody(request));
    bodies.push(body);
    const result = reply(body, bodies.length);
    if (result.status) {
      response.writeHead(result.status, { 'Content-Type': 'application/json', 'X-Request-ID': 'linear-req-7' });
      response.end(JSON.stringify(result.body));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const event of result.events) response.write(JSON.stringify(event) + '\n');
    response.end();
  };
}

function sourcedReply(number) {
  return {
    events: [
      { type: 'tool', activity: { id: `s${number}`, tool: 'search_web', query: `query ${number}`, status: 'running' } },
      { type: 'delta', text: `Provisional ${number}` },
      { type: 'tool', activity: { id: `s${number}`, tool: 'search_web', query: `query ${number}`, status: 'complete' } },
      {
        type: 'done',
        message: `Answer ${number} [1].\n\nSources:\n1. [Example ${number}](https://example.com/${number})`,
        model: 'fixture-model',
        webSources: [{ title: `Example ${number}`, url: `https://example.com/${number}` }]
      }
    ]
  };
}

test('CLI linear chat reads piped questions, keeps context and prints each final answer once', async () => {
  const bodies = [];
  await withServer(linearGateway(bodies, (_body, number) => sourcedReply(number)), async (endpoint) => {
    for (const env of [{}, { NO_COLOR: '1' }]) {
      bodies.length = 0;
      const result = await runCli(['chat', '--linear'], { OTEKIN_CHAT_API_URL: endpoint, ...env }, [], 'Q1\nQ2\n');
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stderr, '');
      assert.strictEqual(bodies.length, 2);
      assert.deepStrictEqual(bodies[1].messages.map((message) => [message.role, message.content.split('\n')[0]]), [
        ['user', 'Q1'], ['assistant', 'Answer 1 [1].'], ['user', 'Q2']
      ]);
      for (const number of [1, 2]) {
        assert.strictEqual(result.stdout.split(`Answer ${number} [1].`).length - 1, 1);
        assert.strictEqual(result.stdout.split(`Searching: query ${number}`).length - 1, 1);
        assert.match(result.stdout, new RegExp(`fixture-model:\\nAnswer ${number} \\[1\\]\\.\\n\\nSources:\\n1\\. Example ${number} https://example\\.com/${number}\\n`));
      }
      assert.doesNotMatch(result.stdout, /Provisional/);
      assert.doesNotMatch(result.stdout, REDRAW);
      assert.doesNotMatch(result.stdout, SGR);
    }
  });
});

test('CLI linear chat on a NO_COLOR or dumb terminal never redraws or colors', async () => {
  const bodies = [];
  await withServer(linearGateway(bodies, (_body, number) => sourcedReply(number)), async (endpoint) => {
    for (const env of [{ TERM: 'xterm-256color', NO_COLOR: '1' }, { TERM: 'dumb', NO_COLOR: undefined }]) {
      const result = await runCli(['chat', '--linear', 'hello'], { OTEKIN_CHAT_API_URL: endpoint, ...env }, TTY_STDOUT, '');
      assert.strictEqual(result.code, 0);
      assert.match(result.stdout, /You: hello\nResearching…\nSearching: query \d\nfixture-model:\n/);
      assert.doesNotMatch(result.stdout, REDRAW);
      assert.doesNotMatch(result.stdout, SGR);
    }
  });
});

test('CLI linear chat sends a prompt argument as the first turn, then continues', async () => {
  const bodies = [];
  await withServer(linearGateway(bodies, (_body, number) => sourcedReply(number)), async (endpoint) => {
    const result = await runCli(['chat', '--linear', 'first'], { OTEKIN_CHAT_API_URL: endpoint }, [], 'second\n');
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(bodies.map((body) => body.messages.at(-1).content), ['first', 'second']);
    assert.strictEqual(bodies[1].messages[0].content, 'first');
  });
});

test('CLI linear chat accepts --reduced-motion and prints exactly what it prints without it', async () => {
  const outputs = [];
  for (const args of [['chat', '--linear', 'first'], ['chat', '--linear', '--reduced-motion', 'first']]) {
    await withServer(linearGateway([], () => ({ events: [{ type: 'done', message: 'Still answer.', model: 'fixture-model' }] })),
      async (endpoint) => {
        const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint }, [], '');
        assert.strictEqual(result.code, 0, args.join(' '));
        outputs.push(result.stdout + result.stderr);
      });
  }
  assert.match(outputs[0], /Still answer\./);
  assert.strictEqual(outputs[1], outputs[0]);
});

test('CLI linear chat sends a prompt argument that looks like a command as a question', async () => {
  const bodies = [];
  await withServer(linearGateway(bodies, (_body, number) => sourcedReply(number)), async (endpoint) => {
    for (const args of [['chat', '--linear', '--', '/exit'], ['chat', '--linear', '/exit']]) {
      bodies.length = 0;
      // The piped /exit still ends the session, so the line after it is never sent.
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint }, [], 'second\n/exit\nthird\n');
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stderr, '');
      assert.deepStrictEqual(bodies.map((body) => body.messages.at(-1).content), ['/exit', 'second']);
      assert.strictEqual(bodies[1].messages[0].content, '/exit');
      assert.match(result.stdout, /You: \/exit\nResearching…\n/);
    }
  });
});

test('CLI linear chat says a question was not sent when the health check fails, and sends nothing', async () => {
  const bodies = [];
  await withServer(linearGateway(bodies, (_body, number) => sourcedReply(number)), async (endpoint, fixture) => {
    const result = await runCli(['chat', '--linear'], { OTEKIN_CHAT_API_URL: endpoint }, [], 'Q1\nQ2\n');
    assert.strictEqual(result.code, 0);
    // Piped questions run in order, so there is no /retry hint.
    assert.strictEqual(result.stderr,
      'Chat error: Chat service health check failed (HTTP 500). Your question was not sent.\n'.repeat(2));
    assert.strictEqual(bodies.length, 0);
    assert(fixture.getRequests().every((request) => request.method === 'GET'));
  }, (request, response) => {
    request.resume();
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'unavailable' }));
  });
});

test('CLI linear chat reports a gateway error and keeps going with the previous history', async () => {
  const bodies = [];
  await withServer(linearGateway(bodies, (_body, number) => number === 2
    ? { status: 502, body: { error: 'secret provider detail', code: 'generation_unavailable' } }
    : sourcedReply(number)), async (endpoint) => {
    const result = await runCli(['chat', '--linear'], { OTEKIN_CHAT_API_URL: endpoint }, [], 'Q1\nQ2\nQ3\n');
    assert.strictEqual(result.code, 0);
    // Piped questions run in order, so there is no /retry hint.
    assert.strictEqual(result.stderr,
      'Chat error: Chat generation is temporarily unavailable. Try again later. (Request ID: linear-req-7) ' +
      'The chat service may have received your question.\n');
    assert.doesNotMatch(result.stdout + result.stderr, /secret provider detail/);
    assert.deepStrictEqual(bodies[2].messages.map((message) => message.content.split('\n')[0]), ['Q1', 'Answer 1 [1].', 'Q3']);
    assert.match(result.stdout, /Answer 3 \[1\]\./);
  });
});

test('CLI linear chat /save writes to the current directory and /retry replaces the saved answer', async () => {
  const bodies = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-cli-linear-'));
  try {
    await withServer(linearGateway(bodies, (_body, number) => sourcedReply(number)), async (endpoint) => {
      const result = await runCli(['chat', '--linear'], { OTEKIN_CHAT_API_URL: endpoint }, [], 'Q1\n/save\n/retry\n/save\n', directory);
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stderr, '');
      assert.deepStrictEqual(bodies.map((body) => body.messages.map((message) => message.content)), [['Q1'], ['Q1']]);
      assert.strictEqual(fs.readdirSync(directory).length, 2);
      // In the order they were saved, which the printed paths give.
      const saved = [...result.stdout.matchAll(/^Saved the conversation to (.+)$/gm)].map((match) => match[1]);
      assert.strictEqual(saved.length, 2);
      saved.forEach((file) => {
        // Only the folder name: process.cwd() may spell the temp path differently, as macOS does.
        assert.strictEqual(path.basename(path.dirname(file)), path.basename(directory));
        assert.match(path.basename(file), /^otekin-chat-\d{8}-\d{6}(-2)?\.md$/);
      });
      const [first, second] = saved.map((file) => fs.readFileSync(file, 'utf8'));
      assert.match(first, /## You\n\nQ1\n\n## fixture-model · [^\n]+\n\nAnswer 1 \[1\]\./);
      // The retry's answer replaced the first one: the second save holds one answer, not two.
      assert.match(second, /Answer 2 \[1\]\./);
      assert.doesNotMatch(second, /Answer 1/);
      assert.strictEqual(second.split('## You').length - 1, 1);
      assert.doesNotMatch(first + second, /Searching|Provisional/);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI opens linear chat for a promptless chat on a TERM=dumb terminal', async () => {
  const bodies = [];
  await withServer(linearGateway(bodies, (_body, number) => sourcedReply(number)), async (endpoint) => {
    const dumb = await runCli(['chat'], { OTEKIN_CHAT_API_URL: endpoint, TERM: 'dumb', OTEKIN_NO_HISTORY: '1' },
      TTY_STDIN.concat(TTY_STDOUT), 'Q1\n/exit\n');
    assert.strictEqual(dumb.code, 0);
    assert.match(dumb.stdout, /^otekin linear chat/);
    assert.match(dumb.stdout, /Answer 1 \[1\]\./);
    assert.doesNotMatch(dumb.stdout, REDRAW);
    assert.strictEqual(bodies.length, 1);

    // Piped stdin still needs a prompt, even on a dumb terminal, and so does --non-interactive.
    for (const [nodeArgs, args] of [[TTY_STDOUT, ['chat']], [TTY_STDIN.concat(TTY_STDOUT), ['chat', '--non-interactive']]]) {
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint, TERM: 'dumb' }, nodeArgs, 'Q\n');
      assert.strictEqual(result.code, 1, args.join(' '));
      assert.match(result.stderr, /requires a prompt/i);
    }
    assert.strictEqual(bodies.length, 1);
  });
});

test('CLI rejects --linear with --json or without chat, sending nothing', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Should not be reached.' }));
  }, async (endpoint, fixture) => {
    for (const args of [['chat', '--linear', '--json'], ['--json', 'chat', '--linear', 'hi']]) {
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint }, [], 'Q\n');
      assert.strictEqual(result.code, 1, args.join(' '));
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, /Linear chat does not support --json/);
    }
    for (const args of [['--linear'], ['cv', '--linear', '--no-open'], ['pilcrow', '--linear']]) {
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint }, [], 'Q\n');
      assert.strictEqual(result.code, 1, args.join(' '));
      assert.strictEqual(result.stdout, '');
    }
    assert.deepStrictEqual(fixture.getRequests(), []);
  });
});

function healthReply(statusCode, body, headers) {
  return (request, response) => {
    request.resume();
    response.writeHead(statusCode, Object.assign({ 'Content-Type': 'application/json' }, headers));
    response.end(JSON.stringify(body));
  };
}

function noChat() {
  throw new Error('chat --status must not send a chat request');
}

function hostOf(endpoint) {
  return new URL(endpoint).host;
}

test('CLI chat --status reports a reachable service with one GET and no chat request', async () => {
  await withServer(noChat, async (endpoint, fixture) => {
    const human = await runCli(['chat', '--status'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(human.code, 0);
    assert.strictEqual(human.stderr, '');
    assert.match(human.stdout,
      new RegExp(`^Chat service: reachable \\(${hostOf(endpoint).replace(/\./g, '\\.')}, \\d+\\.\\d s, Request ID: health-ok\\)\\n$`));
    assert.deepStrictEqual(fixture.getRequests().map((item) => `${item.method} ${item.url}`), ['GET /healthz']);

    const json = await runCli(['--json', 'chat', '--status'], { OTEKIN_CHAT_API_URL: endpoint });
    assert.strictEqual(json.code, 0);
    assert.strictEqual(json.stderr, '');
    const report = JSON.parse(json.stdout);
    assert.deepStrictEqual(Object.keys(report),
      ['status', 'endpoint', 'httpStatus', 'requestId', 'elapsedMs', 'message']);
    assert.strictEqual(report.status, 'reachable');
    assert.strictEqual(report.endpoint, endpoint.replace('/v1/chat', '/healthz'));
    assert.strictEqual(report.httpStatus, 200);
    assert.strictEqual(report.requestId, 'health-ok');
    assert.strictEqual(typeof report.elapsedMs, 'number');
    assert.strictEqual(report.message, 'Chat service is reachable.');
    assert.deepStrictEqual(fixture.getRequests().map((item) => `${item.method} ${item.url}`),
      ['GET /healthz', 'GET /healthz']);
  }, healthReply(200, { ok: true }, { 'X-Request-ID': 'health-ok' }));
});

test('CLI chat --status reports waking and unavailable services with exit code 1 and no retries', async () => {
  for (const [statusCode, state, message] of [
    [502, 'waking', 'Chat service is not ready yet (HTTP 502); it may be waking up.'],
    [503, 'waking', 'Chat service is not ready yet (HTTP 503); it may be waking up.'],
    [504, 'waking', 'Chat service is not ready yet (HTTP 504); it may be waking up.'],
    [500, 'unavailable', 'Chat service health check failed (HTTP 500).'],
    [404, 'unavailable', 'Chat service health check failed (HTTP 404).']
  ]) {
    await withServer(noChat, async (endpoint, fixture) => {
      const human = await runCli(['chat', '--status'], { OTEKIN_CHAT_API_URL: endpoint });
      assert.strictEqual(human.code, 1, String(statusCode));
      assert.strictEqual(human.stderr, '');
      assert.match(human.stdout, new RegExp(`^Chat service: ${state} \\(${hostOf(endpoint).replace(/\./g, '\\.')}, \\d+\\.\\d s\\)\\. `));
      assert.ok(human.stdout.endsWith(` ${message}\n`), human.stdout);

      const json = await runCli(['chat', '--status', '--json'], { OTEKIN_CHAT_API_URL: endpoint });
      assert.strictEqual(json.code, 1, String(statusCode));
      const report = JSON.parse(json.stdout);
      assert.strictEqual(report.status, state);
      assert.strictEqual(report.httpStatus, statusCode);
      assert.strictEqual(report.requestId, null);
      assert.strictEqual(report.message, message);
      assert.deepStrictEqual(fixture.getRequests().map((item) => `${item.method} ${item.url}`),
        ['GET /healthz', 'GET /healthz'], String(statusCode));
    }, healthReply(statusCode, { error: 'down' }));
  }

  const refused = await runCli(['chat', '--status', '--json']);
  assert.strictEqual(refused.code, 1);
  assert.deepStrictEqual(Object.assign(JSON.parse(refused.stdout), { elapsedMs: 0 }), {
    status: 'unavailable',
    endpoint: 'http://127.0.0.1:1/healthz',
    httpStatus: null,
    requestId: null,
    elapsedMs: 0,
    message: 'Unable to reach chat service.'
  });
});

// A gateway written byte by byte, so a header can carry characters Node's server refuses to send.
async function withRawHealth(head, run) {
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end(Buffer.from(`${head}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`, 'latin1')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    const { port } = /** @type {import('net').AddressInfo} */ (server.address());
    await run(`http://127.0.0.1:${port}/v1/chat`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('CLI chat --status never prints control characters from a hostile request ID', async () => {
  // Node's client accepts C1 bytes in a header value and refuses ESC and BEL outright.
  for (const head of [
    'HTTP/1.1 503 Service Unavailable\r\nX-Request-ID: evil\u009b31mred­',
    'HTTP/1.1 503 Service Unavailable\r\nX-Request-ID: evil\u001b]52;c;ZXZpbA==\u0007'
  ]) {
    await withRawHealth(head, async (endpoint) => {
      for (const args of [['chat', '--status'], ['chat', '--status', '--json']]) {
        const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint });
        assert.strictEqual(result.code, 1);
        assert.doesNotMatch(result.stdout, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]|evil/);
        assert.doesNotMatch(result.stdout, /Request ID/);
        if (args.includes('--json')) assert.strictEqual(JSON.parse(result.stdout).requestId, null);
      }
    });
  }
});

test('CLI chat --status reports an invalid URL override as unavailable', async () => {
  const human = await runCli(['chat', '--status'], { OTEKIN_CHAT_API_URL: 'not a url' });
  assert.strictEqual(human.code, 1);
  assert.match(human.stdout, /^Chat service: unavailable \(\d+\.\d s\)\. Chat service URL is invalid\.\n$/);

  const json = await runCli(['chat', '--status', '--json'], {
    OTEKIN_CHAT_HEALTH_URL: 'file:///tmp/healthz'
  });
  assert.strictEqual(json.code, 1);
  const report = JSON.parse(json.stdout);
  assert.strictEqual(report.status, 'unavailable');
  assert.strictEqual(report.endpoint, null);
  assert.strictEqual(report.message, 'Chat service health URL must use HTTP or HTTPS.');
});

test('CLI chat --status honours OTEKIN_CHAT_HEALTH_URL and never shows its credentials or query', async () => {
  await withServer((request, response) => {
    if (request.method !== 'GET' || !request.url.startsWith('/ready')) noChat();
    healthReply(200, { ok: true })(request, response);
  }, async (endpoint, fixture) => {
    const url = new URL(endpoint.replace('/v1/chat', '/ready?token=secret#frag'));
    url.username = 'user';
    url.password = 'hunter2';
    for (const args of [['chat', '--status'], ['chat', '--status', '--json']]) {
      const result = await runCli(args, { OTEKIN_CHAT_HEALTH_URL: url.href });
      assert.strictEqual(result.code, 0);
      assert.doesNotMatch(result.stdout, /user|hunter2|secret|frag/);
    }
    const report = JSON.parse((await runCli(['chat', '--status', '--json'], { OTEKIN_CHAT_HEALTH_URL: url.href })).stdout);
    assert.strictEqual(report.endpoint, endpoint.replace('/v1/chat', '/ready'));
    assert.deepStrictEqual(fixture.getRequests().map((item) => `${item.method} ${item.url}`),
      ['GET /ready?token=secret', 'GET /ready?token=secret', 'GET /ready?token=secret']);
  });
});

test('CLI chat --status rejects a prompt, --linear or a missing chat command, sending nothing', async () => {
  await withServer(noChat, async (endpoint, fixture) => {
    /** @type {Array<[string[], RegExp]>} */
    const cases = [
      [['--status'], /^--status works only with chat\. Run "otekin chat --status"\.\n$/],
      [['cv', '--status', '--no-open'], /^--status works only with chat/],
      [['--json', '--status'], /^--status works only with chat/],
      [['chat', '--status', 'Is it up?'], /^--status does not take a prompt\. Run "otekin chat --status" on its own\.\n$/],
      [['chat', '--status', '--', '--help'], /^--status does not take a prompt/],
      [['chat', '--status', '--linear'], /^--status does not take --linear\. Run "otekin chat --status" on its own\.\n$/],
      [['pilcrow', '--status'], /^Pilcrow installation accepts only/],
      [['chat', '--statuses'], /^Unknown option: --statuses\n/]
    ];
    for (const [args, message] of cases) {
      const result = await runCli(args, { OTEKIN_CHAT_API_URL: endpoint }, [], 'Q\n');
      assert.strictEqual(result.code, 1, args.join(' '));
      assert.strictEqual(result.stdout, '', args.join(' '));
      assert.match(result.stderr, message, args.join(' '));
    }
    assert.deepStrictEqual(fixture.getRequests(), []);
  });
});

test('CLI chat --status on a terminal never opens a chat or touches the history file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-cli-status-'));
  const missing = path.join(directory, 'state', 'history.json');
  const existing = path.join(directory, 'history.json');
  fs.writeFileSync(existing, '{"not":"a history"}');
  const before = fs.statSync(existing).mtimeMs;
  try {
    await withServer(noChat, async (endpoint, fixture) => {
      for (const file of [missing, existing]) {
        for (const extra of [[], ['--json'], ['--reduced-motion']]) {
          const result = await runCli(['chat', '--status'].concat(extra), {
            OTEKIN_CHAT_API_URL: endpoint,
            OTEKIN_HISTORY_FILE: file,
            TERM: 'xterm-256color'
          }, TTY_STDIN.concat(TTY_STDOUT));
          assert.strictEqual(result.code, 0, extra.join(' '));
          assert.doesNotMatch(result.stdout, REDRAW);
          assert.doesNotMatch(result.stdout, /You:|Continuing/);
        }
      }
      assert.strictEqual(fs.existsSync(path.dirname(missing)), false);
      assert.strictEqual(fs.readFileSync(existing, 'utf8'), '{"not":"a history"}');
      assert.strictEqual(fs.statSync(existing).mtimeMs, before);
      assert.ok(fixture.getRequests().every((item) => item.method === 'GET' && item.url === '/healthz'));
    }, healthReply(200, { ok: true }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

if (process.platform !== 'win32') {
  test('CLI chat --status exits 130 without an error line when Ctrl+C cancels it', async () => {
    let arrived;
    const requested = new Promise((resolve) => {
      arrived = resolve;
    });
    await withServer(noChat, async (endpoint) => {
      const child = spawn(process.execPath, [CLI, 'chat', '--status'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { OTEKIN_CHAT_API_URL: endpoint, OTEKIN_CHAT_HEALTH_URL: '' }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const output = [];
      child.stdout.on('data', (chunk) => output.push(chunk));
      child.stderr.on('data', (chunk) => output.push(chunk));
      const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
      await requested;
      child.kill('SIGINT');
      assert.strictEqual(await closed, 130);
      assert.strictEqual(Buffer.concat(output).toString('utf8'), '');
    }, (request) => {
      request.resume();
      arrived();
    });
  });
}

test('CLI help documents chat --status, its states, JSON fields and exit codes', async () => {
  const help = await runCli(['--help']);
  assert.strictEqual(help.code, 0);
  assert.match(help.stdout, /npx otekin chat --status/);
  assert.match(help.stdout, /--status\s+With chat: check once whether the chat service is up/);
  for (const word of ['reachable', 'waking', 'unavailable', 'httpStatus', 'requestId', 'elapsedMs', 'Exit code 0', '130']) {
    assert.ok(help.stdout.includes(word), word);
  }
  assert.match(help.stdout, /no conversation content, and no research or model\s+providers/);
});

test('CLI piped linear chat never creates or changes the history file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-linear-history-'));
  const file = path.join(directory, 'history.json');
  const absent = path.join(directory, 'state', 'history.json');
  fs.writeFileSync(file, '{"saved":true}');
  try {
    await withServer(linearGateway([], (_body, number) => sourcedReply(number)), async (endpoint) => {
      for (const target of [file, absent]) {
        const result = await runCli(['chat', '--linear'], { OTEKIN_CHAT_API_URL: endpoint, OTEKIN_HISTORY_FILE: target }, [], 'Q1\nQ2\n');
        assert.strictEqual(result.code, 0);
      }
    });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"saved":true}');
    assert.strictEqual(fs.existsSync(path.dirname(absent)), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI linear chat at a terminal saves history and continues it in the next run', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-linear-tty-history-'));
  const file = path.join(directory, 'state', 'history.json');
  const bodies = [];
  try {
    await withServer(linearGateway(bodies, (_body, number) => sourcedReply(number)), async (endpoint) => {
      const env = { OTEKIN_CHAT_API_URL: endpoint, OTEKIN_HISTORY_FILE: file };
      const first = await runCli(['chat', '--linear'], env, TTY_STDIN, 'Q1\n');
      assert.strictEqual(first.code, 0);
      assert.doesNotMatch(first.stdout, /Continuing/);
      const saved = chatHistory.loadHistory(file);
      assert(saved, 'the first run saved its conversation');
      assert.deepStrictEqual(saved.prompts, ['Q1']);
      assert.deepStrictEqual(saved.messages.map((message) => message.role), ['user', 'assistant']);
      assert.deepStrictEqual(saved.messages[1].sources, [{ number: 1, title: 'Example 1', url: 'https://example.com/1' }]);
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

      const second = await runCli(['chat', '--linear'], env, TTY_STDIN, 'Q2\n');
      assert.strictEqual(second.code, 0);
      assert.strictEqual(second.stdout.split('Continuing your saved conversation (1 question). /last shows the latest reply; /clear forgets it; --no-history skips it.\n').length - 1, 1);
      assert.strictEqual(second.stdout.split('Answer 1 [1].').length - 1, 0);
      assert.deepStrictEqual(bodies[1].messages.map((message) => message.content.split('\n')[0]), ['Q1', 'Answer 1 [1].', 'Q2']);
      assert.deepStrictEqual(chatHistory.loadHistory(file).prompts, ['Q1', 'Q2']);

      // History off: the saved file is neither read nor changed.
      const before = fs.readFileSync(file);
      for (const [args, extra] of [[['chat', '--linear', '--no-history'], {}], [['chat', '--linear'], { OTEKIN_NO_HISTORY: '1' }]]) {
        const count = bodies.length;
        const result = await runCli(args, { ...env, ...extra }, TTY_STDIN, 'Q3\n');
        assert.strictEqual(result.code, 0);
        assert.doesNotMatch(result.stdout, /Continuing/);
        assert.deepStrictEqual(bodies[count].messages, [{ role: 'user', content: 'Q3' }]);
      }
      assert.deepStrictEqual(fs.readFileSync(file), before);

      const cleared = await runCli(['chat', '--linear'], env, TTY_STDIN, '/clear\n');
      assert.strictEqual(cleared.code, 0);
      assert.match(cleared.stdout, /Conversation cleared\n/);
      assert.strictEqual(fs.existsSync(file), false);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI linear chat reads, saves and copies a saved conversation with the gateway down', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otekin-linear-offline-'));
  const file = path.join(directory, 'state', 'history.json');
  const gateway = await startDownGateway();
  try {
    chatHistory.saveHistory(file, {
      history: [],
      messages: [
        { role: 'user', content: 'Saved question' },
        { role: 'assistant', model: 'saved-model', answeredAt: '2026-11-15T09:30:00.000Z', content: 'Saved answer [1].',
          answer: 'Saved answer [1].', sources: [{ number: 1, title: 'Saved source', url: 'https://example.com/saved' }] }
      ],
      prompts: ['Saved question']
    });
    const before = fs.readFileSync(file);
    // No clipboard tool on Linux, so /copy falls back to a file there; macOS and Windows have one.
    const env = { ...gateway.env, OTEKIN_HISTORY_FILE: file, WAYLAND_DISPLAY: undefined, DISPLAY: undefined };
    const offline = async () => {
      const result = await runCli(['chat', '--linear'], env, TTY_STDIN, '/last\n/save\n/copy\n', directory);
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stderr, '');
      assert.match(result.stdout, /\nContinuing your saved conversation \(1 question\)\. \/last shows the latest reply; \/clear forgets it; --no-history skips it\.\n/);
      // A terminal echoes typed lines itself, so the CLI repeats a line only when it arrived before its prompt.
      assert.match(result.stdout, /You: (?:\/last\n)?saved-model · [^\n]*\d{2}:\d{2}:\nSaved answer \[1\]\.\n\nSources:\n1\. Saved source https:\/\/example\.com\/saved\n\n/);
      const saved = result.stdout.match(/^Saved the conversation to (.+)$/m);
      assert(saved, result.stdout);
      assert.match(fs.readFileSync(saved[1], 'utf8'), /## You\n\nSaved question\n\n## saved-model · 2026-11-15 \d{2}:\d{2}\n\nSaved answer \[1\]\.\n\nSources: \[\\\[1\\\] Saved source\]\(https:\/\/example\.com\/saved\)\n$/);
      assert.match(result.stdout, /You: (?:\/copy\n)?(Copied the latest reply \(with 1 source\) to the clipboard|No clipboard available; saved the latest reply \(with 1 source\) to .+)\n/);
      assert.doesNotMatch(result.stdout, SGR);
      assert.doesNotMatch(result.stdout, REDRAW);
    };
    await offline();
    assert.strictEqual(gateway.connections(), 0, 'nothing contacted the gateway');

    const asked = await runCli(['chat', '--linear'], env, TTY_STDIN, 'A new question\n', directory);
    assert.strictEqual(asked.code, 0);
    assert.strictEqual(asked.stderr, 'Chat error: Chat service health check failed (HTTP 500). ' +
      'Your question was not sent. Type /retry to send it again.\n');
    assert(gateway.connections() > 0);
    assert(gateway.requests().every((request) => request === 'GET /healthz'), gateway.requests().join(', '));
    assert.deepStrictEqual(fs.readFileSync(file), before, 'a failed question is never saved');

    const connections = gateway.connections();
    await offline();
    assert.strictEqual(gateway.connections(), connections);
  } finally {
    await gateway.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI help documents linear chat and its TERM=dumb behavior', async () => {
  const help = await runCli(['--help']);
  assert.match(help.stdout, /npx otekin chat --linear/);
  assert.match(help.stdout, /--linear\s+Chat line by line/);
  assert.match(help.stdout, /TERM=dumb terminal opens it automatically/);
  assert.match(help.stdout, /--no-history\s+Don't load or save chat history this run/);
  assert.match(help.stdout, /full-screen and linear chats save their conversation/);
  assert.match(help.stdout, /piped linear chat\) never read or\s+write it/);
  assert.match(help.stdout, /\/clear forgets the\s+conversation/);
  assert.match(help.stdout, /\/last prints the latest reply again,\s+without the network/);
  assert.doesNotMatch(help.stdout, /does not use saved history yet/);
});

test('CLI help documents --reduced-motion and OTEKIN_REDUCED_MOTION', async () => {
  const help = await runCli(['--help']);
  assert.match(help.stdout, /Options:[^]*--reduced-motion\s+Show a static status instead of spinners and timers[^]*Environment:/);
  assert.match(help.stdout, /Environment:[^]*OTEKIN_REDUCED_MOTION=1\s+Same as --reduced-motion \(0 or empty leaves motion on\)/);
  assert.match(help.stdout, /no spinner or seconds counter/);
});
