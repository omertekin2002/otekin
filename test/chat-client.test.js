'use strict';

const assert = require('assert');
const http = require('http');
const {
  MAX_MESSAGE_CHARACTERS,
  MAX_MESSAGES,
  MAX_TOTAL_CHARACTERS,
  ChatApiError,
  checkChatService,
  ensureChatServiceAwake,
  prepareRequestMessages,
  requestChat
} = require('../lib/chat-client');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        endpoint: `http://127.0.0.1:${server.address().port}/v1/chat`
      });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withServer(handler, run) {
  const fixture = await listen(handler);
  try {
    await run(fixture.endpoint);
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

test('ensureChatServiceAwake checks /healthz without auth or conversation data', async () => {
  await withServer((request, response) => {
    request.resume();
    assert.strictEqual(request.method, 'GET');
    assert.strictEqual(request.url, '/healthz');
    assert.strictEqual(request.headers.accept, 'application/json');
    assert.strictEqual(request.headers.authorization, undefined);
    assert.strictEqual(request.headers['content-length'], undefined);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'signloop-chat-service' }));
  }, async (endpoint) => {
    const result = await ensureChatServiceAwake({ endpoint });
    assert.deepStrictEqual(result, { ok: true, service: 'signloop-chat-service' });
  });
});

test('ensureChatServiceAwake retries transient wake-up responses', async () => {
  let requests = 0;
  await withServer((request, response) => {
    request.resume();
    requests += 1;
    if (requests < 3) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'starting' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'signloop-chat-service' }));
  }, async (endpoint) => {
    const result = await ensureChatServiceAwake({
      endpoint,
      attempts: 3,
      retryDelayMs: 1,
      timeoutMs: 1000
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(requests, 3);
  });
});

test('checkChatService supports an explicit health endpoint override', async () => {
  await withServer((request, response) => {
    request.resume();
    assert.strictEqual(request.url, '/ready');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'custom-fixture' }));
  }, async (endpoint) => {
    const healthEndpoint = endpoint.replace('/v1/chat', '/ready');
    const result = await checkChatService({ endpoint, healthEndpoint });
    assert.strictEqual(result.service, 'custom-fixture');
  });
});

test('checkChatService rejects invalid health responses and unsupported URLs', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: false }));
  }, async (endpoint) => {
    await assert.rejects(checkChatService({ endpoint }), /invalid health response/i);
  });

  await assert.rejects(
    checkChatService({ healthEndpoint: 'file:///tmp/healthz' }),
    /HTTP or HTTPS/i
  );
});

test('checkChatService bounds wake-up time and response size', async () => {
  await withServer((request, response) => {
    request.resume();
    setTimeout(() => {
      if (!response.destroyed) {
        response.end(JSON.stringify({ ok: true, service: 'late' }));
      }
    }, 100);
  }, async (endpoint) => {
    await assert.rejects(checkChatService({ endpoint, timeoutMs: 15 }), /too long to wake/i);
  });

  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, padding: 'x'.repeat(128) }));
  }, async (endpoint) => {
    await assert.rejects(
      checkChatService({ endpoint, maxResponseBytes: 32 }),
      /health response was too large/i
    );
  });
});

test('requestChat sends the exact dependency-free gateway contract', async () => {
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.url, '/v1/chat');
    assert.strictEqual(request.headers['content-type'], 'application/json');
    assert.strictEqual(request.headers.accept, 'application/json');
    assert.strictEqual(request.headers.authorization, undefined);
    assert.deepStrictEqual(Object.keys(body).sort(), ['messages', 'stream']);
    assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
    assert.strictEqual(body.stream, false);
    assert.strictEqual(Number(request.headers['content-length']), Buffer.byteLength(JSON.stringify(body)));

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Hi', provider: 'fixture', webSources: [] }));
  }, async (endpoint) => {
    const result = await requestChat([{ role: 'user', content: 'Hello' }], { endpoint });
    assert.deepStrictEqual(result, { message: 'Hi', provider: 'fixture', webSources: [] });
  });
});

test('requestChat maps non-success responses and captures safe metadata', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '12',
      'X-Request-ID': 'request-fixture'
    });
    response.end(JSON.stringify({ error: 'internal provider detail' }));
  }, async (endpoint) => {
    await assert.rejects(
      requestChat([{ role: 'user', content: 'Hello' }], { endpoint }),
      (error) => {
        assert(error instanceof ChatApiError);
        assert.strictEqual(error.statusCode, 429);
        assert.strictEqual(error.retryAfter, '12');
        assert.strictEqual(error.requestId, 'request-fixture');
        assert.match(error.message, /busy/i);
        assert.doesNotMatch(error.message, /internal provider detail/);
        return true;
      }
    );
  });
});

test('requestChat rejects malformed or incomplete success responses', async () => {
  let requests = 0;
  await withServer((request, response) => {
    request.resume();
    requests += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(requests === 1 ? '{bad json' : JSON.stringify({ provider: 'fixture' }));
  }, async (endpoint) => {
    await assert.rejects(requestChat([], { endpoint }), /invalid JSON/i);
    await assert.rejects(requestChat([], { endpoint }), /invalid response/i);
  });
});

test('requestChat enforces total request time and response size', async () => {
  await withServer((request, response) => {
    request.resume();
    setTimeout(() => {
      if (!response.destroyed) response.end(JSON.stringify({ message: 'late' }));
    }, 100);
  }, async (endpoint) => {
    await assert.rejects(requestChat([], { endpoint, timeoutMs: 15 }), /too long/i);
  });

  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'x'.repeat(128) }));
  }, async (endpoint) => {
    await assert.rejects(requestChat([], { endpoint, maxResponseBytes: 32 }), /too large/i);
  });
});

test('requestChat rejects unsupported endpoint protocols', async () => {
  await assert.rejects(requestChat([], { endpoint: 'file:///tmp/chat' }), /HTTP or HTTPS/i);
});

test('requestChat reports redirects without following them', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(302, { Location: 'https://example.com/elsewhere' });
    response.end();
  }, async (endpoint) => {
    await assert.rejects(requestChat([], { endpoint }), /unexpected redirect/i);
  });
});

test('requestChat supports cancellation for interactive terminal cleanup', async () => {
  await withServer((request) => {
    request.resume();
  }, async (endpoint) => {
    const controller = new AbortController();
    const pending = requestChat([], { endpoint, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancelled/i);
  });
});

test('prepareRequestMessages validates prompts without mutating history', () => {
  assert.throws(() => prepareRequestMessages([], '   '), /cannot be empty/i);
  assert.throws(
    () => prepareRequestMessages([], 'x'.repeat(MAX_MESSAGE_CHARACTERS + 1)),
    /cannot exceed/i
  );

  const history = [
    { role: 'system', content: 'do not send' },
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'A'.repeat(MAX_MESSAGE_CHARACTERS + 200) }
  ];
  const snapshot = JSON.parse(JSON.stringify(history));
  const result = prepareRequestMessages(history, '  New question  ');

  assert.deepStrictEqual(history, snapshot);
  assert.deepStrictEqual(result.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.strictEqual(result[1].content.length, MAX_MESSAGE_CHARACTERS);
  assert.deepStrictEqual(result[result.length - 1], { role: 'user', content: 'New question' });
});

test('prepareRequestMessages drops the oldest complete pairs at message limits', () => {
  const history = [];
  for (let index = 0; index < 20; index += 1) {
    history.push(
      { role: 'user', content: `user-${index}` },
      { role: 'assistant', content: `assistant-${index}` }
    );
  }

  const result = prepareRequestMessages(history, 'latest');
  assert(result.length <= MAX_MESSAGES);
  assert.strictEqual(result.length % 2, 1);
  assert.strictEqual(result[0].content, 'user-6');
  assert.deepStrictEqual(result[result.length - 1], { role: 'user', content: 'latest' });
});

test('prepareRequestMessages drops the oldest complete pairs at character limits', () => {
  const history = [];
  for (let index = 0; index < 15; index += 1) {
    history.push(
      { role: 'user', content: String(index).padEnd(MAX_MESSAGE_CHARACTERS, 'u') },
      { role: 'assistant', content: String(index).padEnd(MAX_MESSAGE_CHARACTERS, 'a') }
    );
  }

  const result = prepareRequestMessages(history, 'latest');
  const total = result.reduce((sum, message) => sum + message.content.length, 0);
  assert(total <= MAX_TOTAL_CHARACTERS);
  assert.strictEqual(result.length % 2, 1);
  assert.strictEqual(result[0].content[0], '8');
  assert.deepStrictEqual(result[result.length - 1], { role: 'user', content: 'latest' });
});

test('a failed request does not mutate committed conversation history', async () => {
  const history = [];
  await withServer((request, response) => {
    request.resume();
    response.writeHead(502, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'failed' }));
  }, async (endpoint) => {
    const candidate = prepareRequestMessages(history, 'Will fail');
    await assert.rejects(requestChat(candidate, { endpoint }));
    assert.deepStrictEqual(history, []);
  });
});
