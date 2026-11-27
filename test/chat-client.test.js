'use strict';

const assert = require('assert');
const dns = require('dns');
const http = require('http');
const net = require('net');
const {
  MAX_MESSAGE_CHARACTERS,
  MAX_MESSAGES,
  MAX_TOTAL_CHARACTERS,
  ChatApiError,
  checkChatService,
  ensureChatServiceAwake,
  omittedTurns,
  prepareRequestMessages,
  probeChatService,
  requestChat
} = require('../lib/chat-client');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        // A TCP server always reports an AddressInfo, never a pipe path.
        endpoint: `http://127.0.0.1:${/** @type {import('net').AddressInfo} */ (server.address()).port}/v1/chat`
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

// A health server that answers every request with `reply` and records each request as "METHOD /path".
async function probeWith(reply, options) {
  const requests = [];
  let result;
  await withServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    reply(response);
  }, async (endpoint) => {
    result = await probeChatService(Object.assign({ endpoint }, options));
  });
  return { result, requests };
}

function jsonReply(statusCode, body, headers) {
  return (response) => {
    response.writeHead(statusCode, Object.assign({ 'Content-Type': 'application/json' }, headers));
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

test('probeChatService reports a reachable service from one GET of the health route', async () => {
  const { result, requests } = await probeWith(jsonReply(200, { ok: true, service: 'fixture' }, {
    'X-Request-ID': 'health-1'
  }));
  assert.deepStrictEqual(requests, ['GET /healthz']);
  assert.strictEqual(result.status, 'reachable');
  assert.match(result.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/healthz$/);
  assert.strictEqual(result.httpStatus, 200);
  assert.strictEqual(result.requestId, 'health-1');
  assert.strictEqual(result.message, 'Chat service is reachable.');
  assert.strictEqual(typeof result.elapsedMs, 'number');
  assert.ok(result.elapsedMs >= 0);
  assert.deepStrictEqual(Object.keys(result).sort(),
    ['elapsedMs', 'endpoint', 'httpStatus', 'message', 'requestId', 'status']);
});

test('probeChatService reports 502, 503 and 504 as waking without retrying or promising recovery', async () => {
  for (const statusCode of [502, 503, 504]) {
    const { result, requests } = await probeWith(jsonReply(statusCode, { error: 'starting' }));
    assert.deepStrictEqual(requests, ['GET /healthz'], String(statusCode));
    assert.strictEqual(result.status, 'waking');
    assert.strictEqual(result.httpStatus, statusCode);
    assert.strictEqual(result.requestId, null);
    assert.strictEqual(result.message, `Chat service is not ready yet (HTTP ${statusCode}); it may be waking up.`);
  }
});

test('probeChatService reports every other outcome as unavailable after one request', async () => {
  /** @type {Array<[(response: http.ServerResponse) => void, number, RegExp]>} */
  const cases = [
    [jsonReply(500, { error: 'down' }), 500, /health check failed \(HTTP 500\)/],
    [jsonReply(404, 'not found'), 404, /health check failed \(HTTP 404\)/],
    [(response) => {
      response.writeHead(302, { Location: 'http://127.0.0.1:1/healthz' });
      response.end();
    }, 302, /unexpected redirect/],
    [jsonReply(200, '{not json'), 200, /invalid health response/],
    [jsonReply(200, { ok: 'yes' }), 200, /invalid health response/],
    [jsonReply(200, [true]), 200, /invalid health response/],
    [jsonReply(200, { ok: true, padding: 'x'.repeat(17 * 1024) }), 200, /health response was too large/]
  ];
  for (const [reply, httpStatus, message] of cases) {
    const { result, requests } = await probeWith(reply);
    assert.deepStrictEqual(requests, ['GET /healthz'], String(message));
    assert.strictEqual(result.status, 'unavailable', String(message));
    assert.strictEqual(result.httpStatus, httpStatus, String(message));
    assert.match(result.message, message);
  }
});

test('probeChatService reports a refused connection as unavailable', async () => {
  const result = await probeChatService({ healthEndpoint: 'http://user:secret@127.0.0.1:1/healthz?token=x#frag' });
  assert.strictEqual(result.status, 'unavailable');
  assert.strictEqual(result.endpoint, 'http://127.0.0.1:1/healthz');
  assert.strictEqual(result.httpStatus, null);
  assert.strictEqual(result.requestId, null);
  assert.strictEqual(result.message, 'Unable to reach chat service.');
});

test('probeChatService finishes within its timeout against a server that never responds', async () => {
  const requests = [];
  await withServer((request) => {
    requests.push(request.method);
    request.resume();
  }, async (endpoint) => {
    const started = Date.now();
    const result = await probeChatService({ endpoint, timeoutMs: 100 });
    assert.ok(Date.now() - started < 2000);
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.httpStatus, null);
    assert.strictEqual(result.message, 'Chat service did not respond within 0.1 s.');
    assert.ok(result.elapsedMs >= 90);
  });
  assert.deepStrictEqual(requests, ['GET']);
});

test('probeChatService keeps the status and request ID when a response body stalls past the timeout', async () => {
  for (const [statusCode, state] of [[503, 'waking'], [200, 'unavailable']]) {
    await withServer((request, response) => {
      request.resume();
      response.writeHead(statusCode, { 'Content-Type': 'application/json', 'X-Request-ID': 'stalled-1' });
      response.flushHeaders();
    }, async (endpoint) => {
      const result = await probeChatService({ endpoint, timeoutMs: 100 });
      assert.strictEqual(result.status, state, String(statusCode));
      assert.strictEqual(result.httpStatus, statusCode);
      assert.strictEqual(result.requestId, 'stalled-1');
      assert.strictEqual(result.message, state === 'waking'
        ? 'Chat service is not ready yet (HTTP 503); it may be waking up.'
        : 'Chat service answered (HTTP 200) but did not finish its response within 0.1 s.');
    });
  }
});

test('probeChatService reports invalid URL overrides as unavailable without a request', async () => {
  const saved = { api: process.env.OTEKIN_CHAT_API_URL, health: process.env.OTEKIN_CHAT_HEALTH_URL };
  try {
    delete process.env.OTEKIN_CHAT_HEALTH_URL;
    process.env.OTEKIN_CHAT_API_URL = 'not a url';
    let result = await probeChatService();
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.endpoint, null);
    assert.strictEqual(result.message, 'Chat service URL is invalid.');

    process.env.OTEKIN_CHAT_HEALTH_URL = 'ftp://127.0.0.1/healthz';
    result = await probeChatService();
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.message, 'Chat service health URL must use HTTP or HTTPS.');
  } finally {
    for (const [key, value] of [['OTEKIN_CHAT_API_URL', saved.api], ['OTEKIN_CHAT_HEALTH_URL', saved.health]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('probeChatService honours OTEKIN_CHAT_API_URL and OTEKIN_CHAT_HEALTH_URL', async () => {
  const saved = { api: process.env.OTEKIN_CHAT_API_URL, health: process.env.OTEKIN_CHAT_HEALTH_URL };
  const urls = [];
  try {
    await withServer((request, response) => {
      urls.push(request.url);
      jsonReply(200, { ok: true })(response);
    }, async (endpoint) => {
      delete process.env.OTEKIN_CHAT_HEALTH_URL;
      process.env.OTEKIN_CHAT_API_URL = endpoint;
      assert.strictEqual((await probeChatService()).status, 'reachable');
      process.env.OTEKIN_CHAT_HEALTH_URL = endpoint.replace('/v1/chat', '/ready');
      const result = await probeChatService();
      assert.strictEqual(result.status, 'reachable');
      assert.match(result.endpoint, /\/ready$/);
    });
  } finally {
    for (const [key, value] of [['OTEKIN_CHAT_API_URL', saved.api], ['OTEKIN_CHAT_HEALTH_URL', saved.health]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepStrictEqual(urls, ['/healthz', '/ready']);
});

test('probeChatService rejects only when cancelled', async () => {
  await withServer((request) => {
    request.resume();
  }, async (endpoint) => {
    const controller = new AbortController();
    const probe = probeChatService({ endpoint, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(probe, /cancelled/i);
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

test('requestChat omits research so the gateway applies its default auto mode', async () => {
  const bodies = [];
  await withServer(async (request, response) => {
    bodies.push(JSON.parse(await readBody(request)));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Hi' }));
  }, async (endpoint) => {
    await requestChat([{ role: 'user', content: 'Hello' }], { endpoint, onActivity() {} });
    // A stale caller option must not reintroduce the field.
    await requestChat([{ role: 'user', content: 'Hello' }], { endpoint, researchMode: 'always' });
  });

  assert.deepStrictEqual(bodies.map((body) => Object.keys(body).sort()), [
    ['messages', 'stream'],
    ['messages', 'stream']
  ]);
  assert.deepStrictEqual(bodies.map((body) => body.stream), [true, false]);
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
  /** @type {Array<[number, string, RegExp]>} */
  const fixtures = [
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

test('an unexpected research_unavailable code falls back to the generic provider failure', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(502, { 'Content-Type': 'application/json', 'X-Request-ID': 'legacy-research' });
    response.end(JSON.stringify({ error: 'private upstream detail', code: 'research_unavailable' }));
  }, async (endpoint) => {
    await assert.rejects(
      requestChat([{ role: 'user', content: 'Hello' }], { endpoint }),
      (error) => {
        assert(error instanceof ChatApiError);
        assert.strictEqual(error.statusCode, 502);
        assert.strictEqual(error.code, null);
        assert.strictEqual(error.requestId, 'legacy-research');
        assert.strictEqual(error.message, 'Chat service research or model provider failed.');
        assert.doesNotMatch(error.message, /--research|private upstream detail/i);
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

// A raw TCP listener: `onConnection` decides what happens to each accepted socket.
async function withTcpServer(onConnection, run) {
  const server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

// A free local port that nothing listens on, so connecting to it is refused.
async function closedPort() {
  let port = 0;
  await withTcpServer(() => {}, async (free) => { port = free; });
  return port;
}

/** Resolves to the ChatApiError that `promise` rejects with. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ChatApiError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the request to fail' });
}

test('requestChat marks a request that never connected as not sent', async () => {
  const refused = await rejection(requestChat([], { endpoint: `http://127.0.0.1:${await closedPort()}/v1/chat` }));
  assert.strictEqual(refused.message, 'Unable to reach chat service.');
  assert.strictEqual(refused.notSent, true);

  // A name that does not resolve (RFC 6761 reserves .invalid). The lookup fails at once, as a
  // resolver would, so the test doesn't wait on this machine's DNS.
  const lookup = dns.lookup;
  /** @type {any} */ (dns).lookup = (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    process.nextTick(done, Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  };
  let unresolved;
  try {
    unresolved = await rejection(requestChat([], { endpoint: 'http://otekin-chat.invalid/v1/chat' }));
  } finally {
    dns.lookup = lookup;
  }
  assert.strictEqual(unresolved.message, 'Unable to reach chat service.');
  assert.strictEqual(unresolved.notSent, true);

  for (const [endpoint, message] of [
    ['ftp://127.0.0.1/chat', 'Chat service URL must use HTTP or HTTPS.'],
    ['file:///tmp/chat', 'Chat service URL must use HTTP or HTTPS.'],
    ['not a url', 'Chat service URL is invalid.']
  ]) {
    const error = await rejection(requestChat([], { endpoint }));
    assert.strictEqual(error.message, message);
    assert.strictEqual(error.notSent, true, endpoint);
  }
});

test('requestChat marks an HTTPS request whose TLS handshake failed or never finished as not sent', async () => {
  // The listener accepts TCP but never speaks TLS: no request byte can be written before the handshake.
  let accepted = 0;
  await withTcpServer((socket) => {
    accepted += 1;
    socket.once('data', () => socket.destroy());
  }, async (port) => {
    const error = await rejection(requestChat([], { endpoint: `https://127.0.0.1:${port}/v1/chat` }));
    assert.strictEqual(error.message, 'Unable to reach chat service.');
    assert.strictEqual(error.notSent, true);
  });
  assert.strictEqual(accepted, 1);

  const sockets = [];
  await withTcpServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
  }, async (port) => {
    const error = await rejection(requestChat([], { endpoint: `https://127.0.0.1:${port}/v1/chat`, timeoutMs: 100 }));
    assert.strictEqual(error.message, 'Chat service took too long.');
    assert.strictEqual(error.notSent, true);
    sockets.forEach((socket) => socket.destroy());
  });
});

test('requestChat never marks a request that connected as not sent', async () => {
  // The server reads the request, then drops the connection without a reply.
  let received = '';
  await withTcpServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (chunk) => {
      received += chunk.toString('utf8');
      socket.destroy();
    });
  }, async (port) => {
    const error = await rejection(requestChat([], { endpoint: `http://127.0.0.1:${port}/v1/chat` }));
    assert.strictEqual(error.message, 'Unable to reach chat service.');
    assert.strictEqual(error.notSent, false);
  });
  assert.match(received, /^POST \/v1\/chat HTTP\/1\.1\r\n/);

  // Connected, then the reply stalls past the deadline.
  await withServer((request) => {
    request.resume();
  }, async (endpoint) => {
    const error = await rejection(requestChat([], { endpoint, timeoutMs: 100 }));
    assert.strictEqual(error.message, 'Chat service took too long.');
    assert.strictEqual(error.notSent, false);
  });

  // A 5xx, invalid JSON and an error event in a stream all come after the request was sent.
  const replies = [
    { status: 503, type: 'application/json', body: '{"error":"down"}', message: /HTTP 503/ },
    { status: 200, type: 'application/json', body: 'not json', message: /invalid JSON/ },
    {
      status: 200,
      type: 'application/x-ndjson',
      body: '{"type":"error","code":"generation_unavailable"}\n',
      message: /temporarily unavailable/
    }
  ];
  for (const { status, type, body, message } of replies) {
    await withServer((request, response) => {
      request.resume();
      response.writeHead(status, { 'Content-Type': type });
      response.end(body);
    }, async (endpoint) => {
      const error = await rejection(requestChat([], { endpoint, onDelta: () => {} }));
      assert.match(error.message, message);
      assert.strictEqual(error.notSent, false, String(message));
    });
  }
});

test('requestChat counts a reused keep-alive connection as connected', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const original = http.globalAgent;
  http.globalAgent = agent;
  let requests = 0;
  try {
    await withServer((request, response) => {
      requests += 1;
      request.resume();
      if (requests === 1) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'First.' }));
        return;
      }
      // The second request arrives on the same socket, which the server then drops.
      request.socket.destroy();
    }, async (endpoint) => {
      await requestChat([], { endpoint });
      const error = await rejection(requestChat([], { endpoint }));
      assert.strictEqual(error.message, 'Unable to reach chat service.');
      assert.strictEqual(error.notSent, false);
    });
  } finally {
    http.globalAgent = original;
    agent.destroy();
  }
  assert.strictEqual(requests, 2);
});

test('requestChat does not mark a cancelled request as not sent', async () => {
  await withServer((request) => {
    request.resume();
  }, async (endpoint) => {
    const controller = new AbortController();
    const pending = requestChat([], { endpoint, signal: controller.signal });
    controller.abort();
    const error = await rejection(pending);
    assert.strictEqual(error.message, 'Chat request was cancelled.');
    assert.strictEqual(error.notSent, false);
  });
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

function turns(count, size = 0) {
  const history = [];
  for (let index = 0; index < count; index += 1) {
    history.push(
      { role: 'user', content: size ? String(index).padEnd(size, 'u') : `user-${index}` },
      { role: 'assistant', content: size ? String(index).padEnd(size, 'a') : `assistant-${index}` }
    );
  }
  return history;
}

test('omittedTurns is zero while a request carries every earlier turn', () => {
  assert.strictEqual(omittedTurns([], prepareRequestMessages([], 'first')), 0);
  const history = turns(14);
  const messages = prepareRequestMessages(history, 'latest');
  assert.strictEqual(messages.length, MAX_MESSAGES - 1);
  assert.strictEqual(omittedTurns(history, messages), 0);
  // Unanswered questions, notices, errors and tool lines are not turns the request could carry.
  const transcript = [{ role: 'notice', content: 'Restored' }, { role: 'user', content: 'failed' },
    { role: 'error', content: 'Chat error' }].concat(history.slice(0, 2), { role: 'tools', content: 'search' },
    history.slice(2), { role: 'user', content: 'cancelled' });
  assert.strictEqual(omittedTurns(transcript, messages), 0);
  assert.strictEqual(omittedTurns(null, null), 0);
});

test('omittedTurns counts the oldest turns dropped at the message limit', () => {
  const fifteen = turns(15);
  assert.strictEqual(omittedTurns(fifteen, prepareRequestMessages(fifteen, 'latest')), 1);
  const twenty = turns(20);
  const messages = prepareRequestMessages(twenty, 'latest');
  assert.strictEqual(messages[0].content, 'user-6');
  assert.strictEqual(omittedTurns(twenty, messages), 6);
});

test('omittedTurns counts the oldest turns dropped at the character budget', () => {
  const history = turns(4, MAX_MESSAGE_CHARACTERS);
  assert.strictEqual(omittedTurns(history, prepareRequestMessages(history, 'latest')), 0);
  const long = turns(15, MAX_MESSAGE_CHARACTERS);
  const messages = prepareRequestMessages(long, 'latest');
  assert(messages.length < MAX_MESSAGES);
  assert.strictEqual(messages[0].content[0], '8');
  assert.strictEqual(omittedTurns(long, messages), 8);
});

test('omittedTurns compares a restored transcript with its already trimmed request history', () => {
  // Large replies trimmed the last request to its newest turns; the transcript still shows them all.
  const transcript = turns(10, MAX_MESSAGE_CHARACTERS);
  const last = prepareRequestMessages(transcript.slice(0, -2), transcript[transcript.length - 2].content);
  assert.strictEqual(last[0].content[0], '3');
  // Saved request history is that request plus its reply: the oldest turns are already gone.
  const saved = last.concat(transcript[transcript.length - 1]);
  const messages = prepareRequestMessages(saved, 'Follow up');
  assert.strictEqual(messages.length, saved.length + 1, 'the follow-up keeps every saved turn');
  assert.strictEqual(omittedTurns(saved, messages), 0, 'request history alone cannot tell');
  assert.strictEqual(omittedTurns(transcript, messages), 3);
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

test('completed replies and their follow-up history compact 24 MiB of raw image data', () => {
  const { MAX_RESPONSE_BYTES, assistantMessageFromResponse } = require('../lib/chat-client');
  for (const separator of [' ', '\n']) {
    const message = ('data:image/png;base64,AAAA' + (separator + 'A'.repeat(76)).repeat(Math.ceil(MAX_RESPONSE_BYTES / 77)))
      .slice(0, MAX_RESPONSE_BYTES);
    let started = Date.now();
    const assistant = assistantMessageFromResponse({ message });
    // About 0.1 s here; a quadratic scan would take minutes.
    assert(Date.now() - started < 3000, `reply took ${Date.now() - started} ms`);
    assert.strictEqual(assistant.content, '[generated image data]');
    started = Date.now();
    const messages = prepareRequestMessages([{ role: 'user', content: 'Draw' }, { role: 'assistant', content: message }], 'Again');
    assert(Date.now() - started < 3000, `history took ${Date.now() - started} ms`);
    assert.strictEqual(messages[1].content, '[generated image data]');
  }
});

test('completed replies compact only image data long enough to be an image', () => {
  const { assistantMessageFromResponse } = require('../lib/chat-client');
  const content = (message) => assistantMessageFromResponse({ message }).content;
  const data = 'QUJD'.repeat(30) + '\n' + 'QUJD'.repeat(30) + '==';
  assert.strictEqual(content(`See data:image/png;base64,${data}. Done`), 'See [generated image data]. Done');
  assert.strictEqual(content(`DATA:IMAGE/SVG+XML;BASE64,${data}`), '[generated image data]');
  assert.strictEqual(content(`![ A chart ](data:image/png;base64,${data})`), '[generated image: A chart]');
  assert.strictEqual(content(`![](data:image/png;base64,${data})`), '[generated image]');
  const unchanged = [
    `data:image/png;base64,${'A'.repeat(199)}`,
    `data:text/plain;base64,${data}`,
    `data:image/;base64,${data}`,
    `data:image/png,${data}`
  ];
  for (const message of unchanged) assert.strictEqual(content(message), message.slice(0, MAX_MESSAGE_CHARACTERS));
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
  assert.strictEqual((/** @type {{ title: string }[]} */ (messages[messages.length - 2].webSources))[0].title, 'Source 13');
  assert.ok(Buffer.byteLength(JSON.stringify({ messages, stream: false })) <= 128 * 1024);
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
    response.end(JSON.stringify({ type: 'error', code: 'generation_unavailable', error: 'private upstream detail' }) + '\n');
  }, async (endpoint) => {
    await assert.rejects(requestChat([], { endpoint, onActivity() {} }), error => {
      assert(error instanceof ChatApiError);
      assert.strictEqual(error.requestId, 'stream-123');
      assert.strictEqual(error.statusCode, 200);
      assert.strictEqual(error.code, 'generation_unavailable');
      assert.match(error.message, /generation is temporarily unavailable/i);
      assert.doesNotMatch(error.message, /private upstream detail/);
      return true;
    });
  });
});

test('streams reject malformed records, incomplete answers, and oversized events', async () => {
  /** @type {Array<[string, RegExp]>} */
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

test('streamed reply deltas reach onDelta in order, across TCP chunks and UTF-8 boundaries', async () => {
  const canonical = { message: 'Merhaba Ömer [1]', webSources: [{ title: 'Source', url: 'https://example.com' }] };
  const events = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    assert.strictEqual(body.stream, true);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(JSON.stringify({ type: 'tool', activity: { id: 's', query: 'q', status: 'running' } }) + '\n');
    const split = Buffer.from(JSON.stringify({ type: 'delta', text: 'Merhaba Ö' }) + '\n');
    const middle = split.indexOf(Buffer.from('Ö')) + 1;
    response.write(Buffer.concat([Buffer.from(JSON.stringify({ type: 'delta', text: 'Hi. ' }) + '\n'), split.subarray(0, middle)]));
    await new Promise(resolve => setTimeout(resolve, 10));
    response.write(split.subarray(middle));
    response.end([
      JSON.stringify({ type: 'delta', text: 42 }),
      JSON.stringify({ type: 'delta' }),
      JSON.stringify({ type: 'delta', text: 'mer' }),
      JSON.stringify({ type: 'done', ...canonical }),
      JSON.stringify({ type: 'delta', text: 'after done' })
    ].join('\n') + '\n');
  }, async (endpoint) => {
    const result = await requestChat([], {
      endpoint,
      timeoutMs: 1000,
      onActivity: activity => events.push(['tool', activity.id]),
      onDelta: text => events.push(['delta', text])
    });
    assert.deepStrictEqual(events, [['tool', 's'], ['delta', 'Hi. '], ['delta', 'Merhaba Ö'], ['delta', 'mer']]);
    assert.deepStrictEqual(result, canonical);
  });
});

test('onDelta alone requests a stream and is never called for JSON replies', async () => {
  const bodies = [];
  await withServer(async (request, response) => {
    bodies.push(JSON.parse(await readBody(request)));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'JSON reply', delta: 'ignored' }));
  }, async (endpoint) => {
    const deltas = [];
    const onDelta = text => deltas.push(text);
    assert.strictEqual((await requestChat([], { endpoint, onDelta })).message, 'JSON reply');
    assert.strictEqual((await requestChat([], { endpoint, onDelta, onActivity() {} })).message, 'JSON reply');
    assert.deepStrictEqual(bodies.map(body => body.stream), [true, true]);
    assert.deepStrictEqual(deltas, []);
  });
});

test('onDelta is not called after the request is aborted', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write([
      JSON.stringify({ type: 'delta', text: 'first' }),
      JSON.stringify({ type: 'delta', text: 'late' })
    ].join('\n') + '\n');
    setTimeout(() => response.end(JSON.stringify({ type: 'delta', text: 'later' }) + '\n'), 20);
  }, async (endpoint) => {
    const controller = new AbortController();
    const deltas = [];
    await assert.rejects(requestChat([], {
      endpoint,
      signal: controller.signal,
      onDelta: text => { deltas.push(text); controller.abort(); }
    }), /cancelled/i);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepStrictEqual(deltas, ['first']);
  });
});

// One stream that exercises every awkward place a TCP chunk can end: a CRLF line, a blank line, an
// unknown event, multi-byte UTF-8 characters, and a final event without a trailing newline.
const awkwardCanonical = { message: 'Son yanıt Ö界 [1]', webSources: [{ title: 'Kaynak', url: 'https://example.com' }] };
const awkwardStream = Buffer.from([
  JSON.stringify({ type: 'tool', activity: { id: 's', query: 'Ömer 界', status: 'running' } }) + '\r\n',
  JSON.stringify({ type: 'delta', text: 'Merhaba Ö' }) + '\n',
  '\n',
  JSON.stringify({ type: 'future-event', value: 'ignore' }) + '\n',
  JSON.stringify({ type: 'delta', text: 'İ界' }) + '\n' + JSON.stringify({ type: 'delta', text: 'x' }) + '\r\n',
  JSON.stringify({ type: 'tool', activity: { id: 's', query: 'Ömer 界', status: 'complete' } }) + '\n',
  JSON.stringify({ type: 'done', ...awkwardCanonical })
].join(''));
const awkwardEvents = [
  ['tool', 's', 'Ömer 界', 'running'],
  ['delta', 'Merhaba Ö'],
  ['delta', 'İ界'],
  ['delta', 'x'],
  ['tool', 's', 'Ömer 界', 'complete']
];

// Byte offsets around every line ending and inside every multi-byte character, plus the edges.
function awkwardOffsets(bytes) {
  const offsets = new Set([1, bytes.length - 1]);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x0a || byte === 0x0d) {
      offsets.add(index);
      offsets.add(index + 1);
    } else if (byte >= 0x80) {
      offsets.add(index);
      offsets.add(index + 1);
    }
  }
  return [...offsets].filter(offset => offset > 0 && offset < bytes.length).sort((a, b) => a - b);
}

// `pause` lets the client read each piece before the next arrives. A timer is coarse on Windows,
// so many-piece streams pass a setImmediate pause instead.
async function streamPieces(pieces, pause = () => new Promise(resolve => setTimeout(resolve, 2))) {
  const events = [];
  let result;
  await withServer(async (request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const piece of pieces.slice(0, -1)) {
      response.write(piece);
      await pause();
    }
    response.end(pieces[pieces.length - 1]);
  }, async (endpoint) => {
    result = await requestChat([], {
      endpoint,
      timeoutMs: 5000,
      onActivity: activity => events.push(['tool', activity.id, activity.query, activity.status]),
      onDelta: text => events.push(['delta', text])
    });
  });
  return { events, result };
}

test('streamed events parse identically however the stream is split into chunks', async () => {
  const whole = await streamPieces([awkwardStream]);
  assert.deepStrictEqual(whole.events, awkwardEvents);
  assert.deepStrictEqual(whole.result, awkwardCanonical);

  const offsets = awkwardOffsets(awkwardStream);
  assert(offsets.length > 20, 'the stream has enough awkward split points to be a meaningful test');
  for (const offset of offsets) {
    const split = await streamPieces([awkwardStream.subarray(0, offset), awkwardStream.subarray(offset)]);
    assert.deepStrictEqual(split.events, awkwardEvents, `split at byte ${offset}`);
    assert.deepStrictEqual(split.result, awkwardCanonical, `split at byte ${offset}`);
  }

  // Several splits at once, including pieces that each hold several whole events.
  const firstLine = awkwardStream.indexOf(0x0a) + 1;
  const lastLine = awkwardStream.lastIndexOf(0x0a) + 1;
  const several = await streamPieces([
    awkwardStream.subarray(0, firstLine - 1),
    awkwardStream.subarray(firstLine - 1, lastLine),
    awkwardStream.subarray(lastLine, lastLine + 5),
    awkwardStream.subarray(lastLine + 5)
  ]);
  assert.deepStrictEqual(several.events, awkwardEvents);
  assert.deepStrictEqual(several.result, awkwardCanonical);

  const bytes = [];
  for (let index = 0; index < awkwardStream.length; index += 1) bytes.push(awkwardStream.subarray(index, index + 1));
  const byByte = await streamPieces(bytes, () => new Promise(resolve => setImmediate(resolve)));
  assert.deepStrictEqual(byByte.events, awkwardEvents);
  assert.deepStrictEqual(byByte.result, awkwardCanonical);
});

test('an unfinished stream line that grows past the limit across chunks fails before the stream ends', async () => {
  const deltas = [];
  await withServer(async (request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(JSON.stringify({ type: 'delta', text: 'first' }) + '\n' + 'x'.repeat(40));
    for (let index = 0; index < 3; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (response.destroyed) return;
      response.write('x'.repeat(40));
    }
    // Never end the stream: only the unfinished-line limit can reject in time.
  }, async (endpoint) => {
    await assert.rejects(requestChat([], {
      endpoint,
      maxResponseBytes: 100,
      timeoutMs: 2000,
      onDelta: text => deltas.push(text)
    }), error => {
      assert(error instanceof ChatApiError);
      assert.strictEqual(error.message, 'Chat service response was too large.');
      return true;
    });
    assert.deepStrictEqual(deltas, ['first']);
  });
});

test('the unfinished stream line limit counts decoded characters, not bytes', async () => {
  // 60 two-byte characters are 120 bytes but only 60 characters: under a 100 limit while unfinished.
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write('"' + 'Ö'.repeat(60));
  }, async (endpoint) => {
    await assert.rejects(requestChat([], {
      endpoint, maxResponseBytes: 100, timeoutMs: 150, onDelta() {}
    }), /took too long/);
  });
});

test('a multi-megabyte streamed event is buffered in linear time', async () => {
  const chunk = 16 * 1024;
  const timeEvent = async (megabytes) => {
    const prefix = '{"type":"done","message":"';
    const suffix = '"}\n';
    const body = Buffer.from(prefix + 'a'.repeat(megabytes * 1024 * 1024 - prefix.length - suffix.length) + suffix);
    let elapsed;
    await withServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let offset = 0;
      const pump = () => {
        while (offset < body.length) {
          const piece = body.subarray(offset, offset + chunk);
          offset += piece.length;
          if (!response.write(piece)) {
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      pump();
    }, async (endpoint) => {
      const started = process.hrtime.bigint();
      const reply = await requestChat([], { endpoint, timeoutMs: 60000, onDelta() {} });
      elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      assert.strictEqual(reply.message.length, body.length - prefix.length - suffix.length);
    });
    return elapsed;
  };
  // Best of two runs each, so one slow garbage collection doesn't decide the result.
  const small = Math.min(await timeEvent(2), await timeEvent(2));
  const large = Math.min(await timeEvent(8), await timeEvent(8));
  // Four times the data: linear buffering takes about 4x as long, quadratic about 16x.
  assert(large < Math.max(small, 20) * 9, `8 MB took ${large.toFixed(0)} ms, 2 MB took ${small.toFixed(0)} ms`);
});
