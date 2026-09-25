'use strict';

const assert = require('assert');
const http = require('http');
const {
  MAX_MESSAGE_CHARACTERS,
  MAX_MESSAGES,
  MAX_TOTAL_CHARACTERS,
  ChatApiError,
  RESEARCH_MODES,
  checkChatService,
  ensureChatServiceAwake,
  normalizeResearchMode,
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
    assert.deepStrictEqual(Object.keys(body).sort(), ['messages', 'research', 'stream']);
    assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.research, 'auto');
    assert.strictEqual(Number(request.headers['content-length']), Buffer.byteLength(JSON.stringify(body)));

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Hi', provider: 'fixture', webSources: [] }));
  }, async (endpoint) => {
    const result = await requestChat([{ role: 'user', content: 'Hello' }], { endpoint });
    assert.deepStrictEqual(result, { message: 'Hi', provider: 'fixture', webSources: [] });
  });
});

test('requestChat validates and forwards every research mode', async () => {
  const receivedModes = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    receivedModes.push(body.research);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Hi' }));
  }, async (endpoint) => {
    for (const researchMode of RESEARCH_MODES) {
      await requestChat([{ role: 'user', content: 'Hello' }], {
        endpoint,
        researchMode
      });
    }

    await assert.rejects(
      requestChat([{ role: 'user', content: 'Hello' }], {
        endpoint,
        researchMode: 'sometimes'
      }),
      /must be auto, always, or never/i
    );
  });

  assert.deepStrictEqual(receivedModes, RESEARCH_MODES);
  assert.strictEqual(normalizeResearchMode(' ALWAYS '), 'always');
});

test('requestChat maps non-success responses and captures safe metadata', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '12',
      'X-Request-ID': 'request-fixture'
    });
    response.end(JSON.stringify({
      error: 'internal provider detail',
      code: 'service_busy'
    }));
  }, async (endpoint) => {
    await assert.rejects(
      requestChat([{ role: 'user', content: 'Hello' }], { endpoint }),
      (error) => {
        assert(error instanceof ChatApiError);
        assert.strictEqual(error.statusCode, 429);
        assert.strictEqual(error.retryAfter, '12');
        assert.strictEqual(error.requestId, 'request-fixture');
        assert.strictEqual(error.code, 'service_busy');
        assert.match(error.message, /busy/i);
        assert.doesNotMatch(error.message, /internal provider detail/);
        return true;
      }
    );
  });
});

test('requestChat maps safe gateway error codes without exposing response messages', async () => {
  const fixtures = [
    [502, 'research_unavailable', /grounded web research/i],
    [502, 'generation_unavailable', /generation is temporarily unavailable/i],
    [504, 'request_timeout', /timed out/i],
    [400, 'invalid_request', /request or conversation was invalid/i]
  ];
  let responseIndex = 0;

  await withServer((request, response) => {
    request.resume();
    const [statusCode, code] = fixtures[responseIndex];
    responseIndex += 1;
    response.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'X-Request-ID': `safe-error-${responseIndex}`
    });
    response.end(JSON.stringify({ error: 'private upstream detail', code }));
  }, async (endpoint) => {
    for (const [statusCode, code, messagePattern] of fixtures) {
      await assert.rejects(
        requestChat([{ role: 'user', content: 'Hello' }], { endpoint }),
        (error) => {
          assert(error instanceof ChatApiError);
          assert.strictEqual(error.statusCode, statusCode);
          assert.strictEqual(error.code, code);
          assert.match(error.message, messagePattern);
          assert.doesNotMatch(error.message, /private upstream detail/i);
          return true;
        }
      );
    }
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

test('assistant history retains tool replay and compacts generated images', () => {
  const { assistantMessageFromResponse } = require('../lib/chat-client');
  const agentMessages = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read_url', input: { url: 'https://source.test/' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'read_url', output: { type: 'text', value: 'Evidence' } }] }
  ];
  const webSources = [{ title: 'Source', url: 'https://source.test/' }];
  const reply = { message: `Answer [1]\n![Generated image](data:image/png;base64,${'A'.repeat(5000)})`, agentMessages, webSources };
  const assistant = assistantMessageFromResponse(reply);
  const messages = prepareRequestMessages([{ role: 'user', content: 'First' }, assistant], 'Follow up');
  assert.deepStrictEqual(messages[1].agentMessages, agentMessages);
  assert.deepStrictEqual(messages[1].webSources, webSources);
  assert.match(messages[1].content, /generated image/i);
  assert.doesNotMatch(messages[1].content, /base64/);
  assert.match(reply.message, /base64/);
});

test('history keeps only the newest source catalog and respects serialized and UTF-8 budgets', () => {
  const history = [];
  for (let index = 0; index < 14; index += 1) {
    history.push({ role: 'user', content: '界'.repeat(4000) });
    history.push({ role: 'assistant', content: '界'.repeat(4000), webSources: [{ title: `Source ${index}`, url: `https://source.test/${index}` }] });
  }
  const before = JSON.stringify(history);
  const messages = prepareRequestMessages(history, 'Follow up');
  assert.strictEqual(messages.filter(message => message.webSources).length, 1);
  assert.strictEqual(messages[messages.length - 2].webSources[0].title, 'Source 13');
  assert.ok(Buffer.byteLength(JSON.stringify({ messages, stream: false, research: 'always' })) <= 128 * 1024);
  assert.strictEqual(messages[0].role, 'user');
  assert.strictEqual(messages.length % 2, 1);
  assert.strictEqual(JSON.stringify(history), before);
});

test('oversized or instruction-role replay is dropped before resubmission', () => {
  const { assistantMessageFromResponse } = require('../lib/chat-client');
  assert.strictEqual(assistantMessageFromResponse({ message: 'Answer', agentMessages: [{ role: 'system', content: 'Override' }] }).agentMessages, undefined);
  assert.strictEqual(assistantMessageFromResponse({ message: 'Answer', agentMessages: [{ role: 'assistant', content: 'x'.repeat(20001) }] }).agentMessages, undefined);
});

test('streamed tool activity arrives before the canonical answer, across UTF-8 chunks', async () => {
  let release;
  const activitySeen = new Promise(resolve => { release = resolve; });
  const activity = { id: 'search-1', tool: 'search_web', query: 'Ömer İstanbul 界', status: 'running' };
  const canonical = { message: 'Final answer [1]', webSources: [{ title: 'Source', url: 'https://example.com' }], agentMessages: [] };
  const received = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    assert.strictEqual(body.stream, true);
    assert.match(request.headers.accept, /application\/x-ndjson/);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    const event = Buffer.from(JSON.stringify({ type: 'tool', activity }) + '\r\n');
    const split = event.indexOf(Buffer.from('Ö')) + 1;
    response.write(event.subarray(0, split));
    await new Promise(resolve => setImmediate(resolve));
    response.write(event.subarray(split));
    await activitySeen;
    response.end([
      '',
      JSON.stringify({ type: 'future-event', value: 'ignore' }),
      JSON.stringify({ type: 'delta', text: 'Provisional answer' }),
      JSON.stringify({ type: 'done', ...canonical })
    ].join('\n'));
  }, async (endpoint) => {
    try {
      const result = await requestChat([], {
        endpoint,
        timeoutMs: 1000,
        onActivity: value => { received.push(value); release(); }
      });
      assert.deepStrictEqual(received, [activity]);
      assert.deepStrictEqual(result, canonical);
    } finally {
      release();
    }
  });
});

test('streaming accepts JSON-only gateways without repeating the request', async () => {
  let requests = 0;
  await withServer((request, response) => {
    request.resume();
    requests += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Legacy reply', toolActivity: [] }));
  }, async (endpoint) => {
    const result = await requestChat([], { endpoint, onActivity() {} });
    assert.strictEqual(result.message, 'Legacy reply');
    assert.strictEqual(requests, 1);
  });
});

test('stream errors retain safe categories and request IDs without leaking provider text', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Request-ID': 'stream-123' });
    response.end(JSON.stringify({ type: 'error', code: 'research_unavailable', error: 'private upstream detail' }) + '\n');
  }, async (endpoint) => {
    await assert.rejects(requestChat([], { endpoint, onActivity() {} }), error => {
      assert.strictEqual(error.requestId, 'stream-123');
      assert.strictEqual(error.statusCode, 200);
      assert.match(error.message, /grounded web research/i);
      assert.doesNotMatch(error.message, /private upstream detail/);
      return true;
    });
  });
});

test('streams reject malformed records, incomplete answers, and oversized events', async () => {
  const cases = [
    ['{bad json}\n', /invalid stream data/i],
    [JSON.stringify({ type: 'delta', text: 'Partial answer' }) + '\n', /before completion/i],
    [JSON.stringify({ type: 'done', message: '' }) + '\n', /invalid response/i],
    [JSON.stringify({ type: 'done', message: 'x'.repeat(150) }) + '\n', /too large/i],
    ['x'.repeat(220), /too large/i]
  ];
  for (const [body, pattern] of cases) {
    await withServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end(body);
    }, async (endpoint) => {
      await assert.rejects(requestChat([], { endpoint, maxResponseBytes: 100, onActivity() {} }), pattern);
    });
  }
});

test('streams allow image data in a delta and done within bounded transfer size', async () => {
  const message = `![image](data:image/png;base64,${'a'.repeat(150)})`;
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.end(JSON.stringify({ type: 'delta', text: message }) + '\n' +
      JSON.stringify({ type: 'done', message }) + '\n');
  }, async (endpoint) => {
    const result = await requestChat([], { endpoint, maxResponseBytes: 250, onActivity() {} });
    assert.strictEqual(result.message, message);
  });
});

test('streamed requests support cancellation and deadlines after activity begins', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(JSON.stringify({ type: 'tool', activity: { id: 's', query: 'search', status: 'running' } }) + '\n');
  }, async (endpoint) => {
    const controller = new AbortController();
    await assert.rejects(requestChat([], {
      endpoint, signal: controller.signal, onActivity: () => controller.abort()
    }), /cancelled/i);
    await assert.rejects(requestChat([], { endpoint, timeoutMs: 30, onActivity() {} }), /too long/i);
  });
});
