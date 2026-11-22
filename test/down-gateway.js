'use strict';

// A chat gateway that is down, for tests that prove saved conversations work offline. It counts
// every TCP connection, so a test can show that nothing contacted it, and answers any request
// with HTTP 500, which the readiness check reports at once as "Your question was not sent."
const http = require('http');

/**
 * @typedef {object} DownGateway
 * @property {{ OTEKIN_CHAT_API_URL: string, OTEKIN_CHAT_HEALTH_URL: string }} env Points the chat client at it.
 * @property {() => number} connections How many TCP connections it has accepted.
 * @property {() => string[]} requests Each request it received, as "METHOD /path".
 * @property {() => Promise<void>} close
 */

/** @returns {Promise<DownGateway>} */
async function startDownGateway() {
  let connections = 0;
  /** @type {string[]} */
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end('{"error":"down"}');
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  return {
    env: {
      OTEKIN_CHAT_API_URL: `http://127.0.0.1:${port}/v1/chat`,
      OTEKIN_CHAT_HEALTH_URL: `http://127.0.0.1:${port}/healthz`
    },
    connections: () => connections,
    requests: () => requests.slice(),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    })
  };
}

/**
 * Runs `run` with this process's chat client pointed at a down gateway, then restores the environment.
 * @template T
 * @param {(gateway: DownGateway) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withDownGateway(run) {
  const gateway = await startDownGateway();
  /** @type {Record<string, string | undefined>} */
  const previous = {};
  for (const [key, value] of Object.entries(gateway.env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await run(gateway);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await gateway.close();
  }
}

module.exports = { startDownGateway, withDownGateway };
