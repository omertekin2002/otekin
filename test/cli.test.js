'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'otekin.js');
const PROFILE_MESSAGE = "Hello! I'm Ömer, I'm a law & business student currently studying at Koç University";

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI].concat(args), {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        OTEKIN_CHAT_API_URL: 'http://127.0.0.1:1/v1/chat',
        OTEKIN_CHAT_HEALTH_URL: ''
      }, env || {}),
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
    child.stdin.end();
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
        endpoint: `http://127.0.0.1:${server.address().port}/v1/chat`,
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
  assert.match(help.stdout, /\/clear/);
  assert.strictEqual(help.stderr, '');

  const version = await runCli(['--version']);
  assert.strictEqual(version.code, 0);
  assert.strictEqual(version.stdout, `${pkg.version}\n`);
  assert.strictEqual(version.stderr, '');
});

test('CLI preserves bare profile JSON output', async () => {
  const result = await runCli(['--json']);
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(JSON.parse(result.stdout), {
    message: PROFILE_MESSAGE,
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
  assert.match(profile.stdout, new RegExp(PROFILE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(profile.stdout, /Links:/);

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
    assert.doesNotMatch(result.stdout, /Hello! I'm Ömer/);
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

test('CLI one-shot --json preserves the complete gateway response', async () => {
  const gatewayResponse = {
    message: 'JSON answer',
    provider: 'fixture',
    model: 'fixture-model',
    webSearchQuery: 'fixture query',
    webSources: [{ url: 'https://example.com' }]
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

test('CLI chat failures are script-friendly and hide response bodies', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(502, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'secret internal failure detail' }));
  }, async (endpoint) => {
    const result = await runCli(['chat', 'Question'], {
      OTEKIN_CHAT_API_URL: endpoint
    });
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.stdout, '');
    assert.match(result.stderr, /research or model provider failed/i);
    assert.doesNotMatch(result.stderr, /secret internal failure detail/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
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
    assert.strictEqual(chatRequests, 0);
    assert.deepStrictEqual(
      fixture.getRequests().map((request) => `${request.method} ${request.url}`),
      ['GET /healthz']
    );
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
