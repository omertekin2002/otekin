'use strict';

const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const {
  afterBase64Subtype, afterDataImage, forwardIndexOf, hideCompleteImageData, replaceMarkdownImages, skipSpaces
} = require('./image-data');

const DEFAULT_CHAT_API_URL = 'https://signloop-chat-api.vercel.app/v1/chat';
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARACTERS = 4000;
const MAX_TOTAL_CHARACTERS = 60000;
// Shown once per conversation when a follow-up first leaves out the oldest turns (see omittedTurns).
const TRIMMED_CONTEXT_NOTICE = 'Older turns stay on screen and in /save, but follow-ups now send only ' +
  'the most recent part of the conversation.';
// Two optional images can contribute up to 8 MiB of base64 each.
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_AGENT_STATE_CHARACTERS = 20000;
const MAX_SOURCE_CATALOG_CHARACTERS = 16000;
const MAX_HEALTH_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_WAKE_TIMEOUT_MS = 120000;
const DEFAULT_WAKE_ATTEMPTS = 30;
const DEFAULT_WAKE_RETRY_DELAY_MS = 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 10000;
const SAFE_ERROR_CODES = new Set([
  'invalid_request',
  'generation_unavailable',
  'request_timeout',
  'service_busy'
]);

class ChatApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ChatApiError';
    this.statusCode = details && details.statusCode ? details.statusCode : null;
    this.retryAfter = details && details.retryAfter ? details.retryAfter : null;
    this.requestId = details && details.requestId ? details.requestId : null;
    this.code = details && details.code ? details.code : null;
    this.retryable = Boolean(details && details.retryable);
    this.timedOut = Boolean(details && details.timedOut);
    // True only when the request certainly never reached the service: the URL was rejected, or
    // the connection failed or timed out before it was established, so nothing was sent.
    this.notSent = Boolean(details && details.notSent);
  }
}

function validationError(message) {
  return new ChatApiError(message);
}

function parseHttpEndpoint(value, label) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ChatApiError(`${label} URL is invalid.`, { notSent: true });
  }

  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new ChatApiError(`${label} URL must use HTTP or HTTPS.`, { notSent: true });
  }
  return endpoint;
}

// Like replacing /!\[([^\]]*)\]\(\s*data:image\/[a-z0-9.+-]+;base64,[^)]+\)/gi, in linear time.
function compactImages(text) {
  const nextParen = forwardIndexOf(text, ')');
  const markdown = replaceMarkdownImages(text, false, (_text, start) => {
    let index = afterDataImage(text, skipSpaces(text, start));
    if (index >= 0) index = afterBase64Subtype(text, index);
    if (index < 0) return null;
    const paren = nextParen(index);
    return paren > index ? { end: paren + 1 } : null;
  }, (alt) => `[generated image${alt.trim() ? `: ${alt.trim()}` : ''}]`);
  return hideCompleteImageData(markdown, '[generated image data]');
}

function boundedMetadata(response) {
  const metadata = {};
  const replay = response.agentMessages;
  if (Array.isArray(replay) && replay.length > 0 && replay.length <= 36 &&
      replay.every((item) => item && (item.role === 'assistant' || item.role === 'tool')) &&
      JSON.stringify(replay).length <= MAX_AGENT_STATE_CHARACTERS) {
    metadata.agentMessages = replay;
  }
  const sources = response.webSources;
  if (Array.isArray(sources) && sources.length > 0 && sources.length <= 64 &&
      JSON.stringify(sources).length <= MAX_SOURCE_CATALOG_CHARACTERS) {
    metadata.webSources = sources;
  }
  return metadata;
}

function assistantMessageFromResponse(response) {
  return Object.assign({
    role: 'assistant',
    content: compactImages(response.message).slice(0, MAX_MESSAGE_CHARACTERS)
  }, boundedMetadata(response));
}

function historyCharacters(message) {
  return message.content.length + JSON.stringify({
    agentMessages: message.agentMessages,
    webSources: message.webSources
  }).length;
}

// Mirrors the request body; `stream: false` is the longer of the two serialized forms.
function requestBytes(messages) {
  return Buffer.byteLength(JSON.stringify({ messages, stream: false }));
}

/**
 * A message as sent to the chat API. Assistant replies may also carry the agent's replay state
 * and the web source catalog their citations refer to (see boundedMetadata).
 * @typedef {{ role: string, content: string, agentMessages?: object[], webSources?: object[] }} RequestMessage
 */

/** @returns {RequestMessage[]} */
function prepareRequestMessages(history, newPrompt) {
  if (typeof newPrompt !== 'string') {
    throw validationError('Chat prompt must be text.');
  }

  const prompt = newPrompt.trim();
  if (!prompt) {
    throw validationError('Chat prompt cannot be empty.');
  }
  if (prompt.length > MAX_MESSAGE_CHARACTERS) {
    throw validationError(`Chat prompt cannot exceed ${MAX_MESSAGE_CHARACTERS} characters.`);
  }

  const source = Array.isArray(history) ? history : [];
  /** @type {RequestMessage[]} */
  const pairs = [];
  let pendingUser = null;

  for (const item of source) {
    if (!item || typeof item.content !== 'string') continue;

    if (item.role === 'user') {
      pendingUser = {
        role: 'user',
        content: item.content.slice(0, MAX_MESSAGE_CHARACTERS)
      };
    } else if (item.role === 'assistant' && pendingUser) {
      pairs.push(
        pendingUser,
        Object.assign({
          role: 'assistant',
          content: compactImages(item.content).slice(0, MAX_MESSAGE_CHARACTERS)
        }, boundedMetadata(item))
      );
      pendingUser = null;
    }
  }

  const messages = pairs.concat({ role: 'user', content: prompt });
  // Source numbers refer to the newest cumulative catalog. Avoid replaying duplicate catalogs.
  let hasSources = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!messages[index].webSources) continue;
    if (hasSources) delete messages[index].webSources;
    else hasSources = true;
  }
  let totalCharacters = messages.reduce((total, message) => total + historyCharacters(message), 0);

  while (
    messages.length > MAX_MESSAGES ||
    totalCharacters > MAX_TOTAL_CHARACTERS ||
    requestBytes(messages) > MAX_REQUEST_BYTES
  ) {
    if (messages.length < 3) break;
    const removed = messages.splice(0, 2);
    totalCharacters -= historyCharacters(removed[0]) + historyCharacters(removed[1]);
  }

  return messages;
}

// Counts completed turns the way prepareRequestMessages pairs them: a question followed by a reply
// before the next question. Other entries (notices, errors, tool lines) are ignored.
function completedTurns(conversation) {
  let turns = 0;
  let pending = false;
  for (const item of Array.isArray(conversation) ? conversation : []) {
    if (!item || typeof item.content !== 'string') continue;
    if (item.role === 'user') {
      pending = true;
    } else if (item.role === 'assistant' && pending) {
      turns += 1;
      pending = false;
    }
  }
  return turns;
}

/**
 * How many earlier completed turns of `conversation` a prepared request leaves out. `conversation`
 * may be request history or a transcript (which, after a restart, can hold more turns than the
 * saved request history); `messages` is what prepareRequestMessages returned for the next prompt.
 * Requests always keep the most recent turns, so the difference is the oldest turns dropped.
 * @param {Array<{ role?: string, content?: unknown } | null | undefined>} conversation
 * @param {Array<{ role?: string } | null | undefined>} messages
 * @returns {number}
 */
function omittedTurns(conversation, messages) {
  const questions = Array.isArray(messages)
    ? messages.filter((message) => message && message.role === 'user').length
    : 0;
  // The last question in a request is the new prompt; the rest are earlier turns.
  return Math.max(0, completedTurns(conversation) - Math.max(0, questions - 1));
}

function errorDetails(statusCode, headers, code) {
  return {
    statusCode,
    retryAfter: headers['retry-after'] || null,
    requestId: headers['x-request-id'] || null,
    code: SAFE_ERROR_CODES.has(code) ? code : null
  };
}

function responseError(statusCode, headers, body) {
  const code = body && typeof body === 'object' && !Array.isArray(body)
    ? body.code
    : null;
  const details = errorDetails(statusCode, headers, code);

  if (details.code === 'invalid_request') {
    return new ChatApiError('Chat request or conversation was invalid.', details);
  }
  if (details.code === 'generation_unavailable') {
    return new ChatApiError('Chat generation is temporarily unavailable. Try again later.', details);
  }
  if (details.code === 'request_timeout') {
    return new ChatApiError('Chat service request timed out.', details);
  }
  if (details.code === 'service_busy') {
    const suffix = details.retryAfter ? ` Retry after ${details.retryAfter}.` : '';
    return new ChatApiError(`Chat service is busy. Try again later.${suffix}`, details);
  }

  if (statusCode >= 300 && statusCode < 400) {
    return new ChatApiError('Chat service returned an unexpected redirect.', details);
  }
  if (statusCode === 400) {
    return new ChatApiError('Chat request or conversation was invalid.', details);
  }
  if (statusCode === 413) {
    return new ChatApiError('Message or conversation history is too large.', details);
  }
  if (statusCode === 429) {
    const suffix = details.retryAfter ? ` Retry after ${details.retryAfter}.` : '';
    return new ChatApiError(`Chat service is busy. Try again later.${suffix}`, details);
  }
  if (statusCode === 502) {
    return new ChatApiError('Chat service research or model provider failed.', details);
  }
  if (statusCode === 504) {
    return new ChatApiError('Chat service request timed out.', details);
  }

  return new ChatApiError(`Chat service request failed (HTTP ${statusCode}).`, details);
}

function healthResponseError(statusCode, headers) {
  const details = errorDetails(statusCode, headers);

  if (statusCode >= 300 && statusCode < 400) {
    return new ChatApiError('Chat service health check returned an unexpected redirect.', details);
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return new ChatApiError('Chat service is still waking up.', Object.assign(details, {
      retryable: true
    }));
  }
  return new ChatApiError(`Chat service health check failed (HTTP ${statusCode}).`, details);
}

function resolveHealthEndpoint(options) {
  const opts = options || {};
  if (opts.healthEndpoint) {
    return parseHttpEndpoint(opts.healthEndpoint, 'Chat service health');
  }
  if (opts.endpoint) {
    return new URL('/healthz', parseHttpEndpoint(opts.endpoint, 'Chat service'));
  }
  if (process.env.OTEKIN_CHAT_HEALTH_URL) {
    return parseHttpEndpoint(process.env.OTEKIN_CHAT_HEALTH_URL, 'Chat service health');
  }

  const chatEndpointValue = process.env.OTEKIN_CHAT_API_URL || DEFAULT_CHAT_API_URL;
  const chatEndpoint = parseHttpEndpoint(chatEndpointValue, 'Chat service');
  return new URL('/healthz', chatEndpoint);
}

// One GET of the readiness route. Resolves to the parsed `{ ok: true }` body with the response's
// status code and headers; rejects with a ChatApiError that carries them when there was a response.
function requestHealth(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_WAKE_TIMEOUT_MS : opts.timeoutMs;
  const maxResponseBytes = opts.maxResponseBytes === undefined
    ? MAX_HEALTH_RESPONSE_BYTES
    : opts.maxResponseBytes;
  const signal = opts.signal;

  if (signal && signal.aborted) {
    return Promise.reject(new ChatApiError('Chat request was cancelled.'));
  }

  let endpoint;
  try {
    endpoint = resolveHealthEndpoint(opts);
  } catch (error) {
    return Promise.reject(error);
  }

  const transport = endpoint.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let timer;
    // The status and headers, once a response has started, so a stalled body still reports them.
    let received = null;

    const onAbort = () => {
      if (request) request.destroy();
      settle(reject, new ChatApiError('Chat request was cancelled.'));
    };

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      callback(value);
    };

    timer = setTimeout(() => {
      if (request) request.destroy();
      settle(reject, new ChatApiError('Chat service took too long to wake up.', Object.assign(
        received ? errorDetails(received.statusCode, received.headers) : {},
        { retryable: true, timedOut: true }
      )));
    }, timeoutMs);

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

    request = transport.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      path: endpoint.pathname + endpoint.search,
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    }, (response) => {
      const statusCode = response.statusCode || 0;
      const headers = response.headers;
      const chunks = [];
      let responseBytes = 0;
      received = { statusCode, headers };

      response.on('data', (chunk) => {
        if (settled) return;
        responseBytes += chunk.length;
        if (responseBytes > maxResponseBytes) {
          response.destroy();
          settle(reject, new ChatApiError(
            'Chat service health response was too large.',
            errorDetails(statusCode, headers)
          ));
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        if (settled) return;
        if (statusCode < 200 || statusCode >= 300) {
          settle(reject, healthResponseError(statusCode, headers));
          return;
        }

        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          settle(reject, new ChatApiError(
            'Chat service returned an invalid health response.',
            errorDetails(statusCode, headers)
          ));
          return;
        }

        if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok !== true) {
          settle(reject, new ChatApiError(
            'Chat service returned an invalid health response.',
            errorDetails(statusCode, headers)
          ));
          return;
        }

        settle(resolve, { data, statusCode, headers });
      });

      response.on('error', () => {
        settle(reject, new ChatApiError('Unable to read the chat service health response.', {
          statusCode,
          requestId: headers['x-request-id'] || null,
          retryable: true
        }));
      });
    });

    request.on('error', () => {
      settle(reject, new ChatApiError('Unable to wake chat service.', { retryable: true }));
    });

    request.end();
  });
}

function checkChatService(options) {
  return requestHealth(options).then((result) => result.data);
}

/**
 * The origin and path of a health URL, without user info, query or fragment, for display.
 * @param {URL} endpoint
 */
function displayEndpoint(endpoint) {
  return endpoint.origin + endpoint.pathname;
}

/**
 * @typedef {object} ChatServiceStatus
 * @property {'reachable' | 'waking' | 'unavailable'} status
 * @property {string | null} endpoint The health URL's origin and path, or null when it is invalid.
 * @property {number | null} httpStatus
 * @property {string | null} requestId The gateway's raw x-request-id header; sanitise before display.
 * @property {number} elapsedMs
 * @property {string} message
 */

/**
 * Checks once whether the chat service is up, with a single GET of its readiness route: no retries,
 * no conversation content and no research or model providers. Resolves for every service outcome,
 * including an invalid health URL; rejects only when `signal` cancels it.
 * @param {{ healthEndpoint?: string, endpoint?: string, timeoutMs?: number,
 *   maxResponseBytes?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<ChatServiceStatus>}
 */
async function probeChatService(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_PROBE_TIMEOUT_MS : opts.timeoutMs;
  const startedAt = Date.now();
  /** @param {Omit<ChatServiceStatus, 'elapsedMs'>} result */
  const finish = (result) => Object.assign(result, { elapsedMs: Date.now() - startedAt });

  let endpoint;
  try {
    endpoint = resolveHealthEndpoint(opts);
  } catch (error) {
    return finish({
      status: 'unavailable', endpoint: null, httpStatus: null, requestId: null, message: error.message
    });
  }
  const shown = displayEndpoint(endpoint);

  try {
    const { statusCode, headers } = await requestHealth(Object.assign({}, opts, {
      healthEndpoint: endpoint.href,
      timeoutMs
    }));
    return finish({
      status: 'reachable',
      endpoint: shown,
      httpStatus: statusCode,
      requestId: requestIdHeader(headers),
      message: 'Chat service is reachable.'
    });
  } catch (error) {
    if (opts.signal && opts.signal.aborted) throw error;
    const httpStatus = error && error.statusCode ? error.statusCode : null;
    const requestId = error && error.requestId ? String(error.requestId) : null;
    if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
      return finish({
        status: 'waking',
        endpoint: shown,
        httpStatus,
        requestId,
        // These also mean a failing service, so never promise that it will come up.
        message: `Chat service is not ready yet (HTTP ${httpStatus}); it may be waking up.`
      });
    }
    let message;
    if (error && error.timedOut) message = `Chat service did not respond within ${formatSeconds(timeoutMs)}.`;
    // Without a status code the request never got a response: the connection failed.
    else if (!httpStatus) message = 'Unable to reach chat service.';
    else message = error.message;
    return finish({ status: 'unavailable', endpoint: shown, httpStatus, requestId, message });
  }
}

function requestIdHeader(headers) {
  const value = headers && headers['x-request-id'];
  return typeof value === 'string' && value ? value : null;
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

/** @returns {Promise<void>} */
function waitForRetry(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  if (signal && signal.aborted) {
    return Promise.reject(new ChatApiError('Chat request was cancelled.'));
  }

  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      reject(new ChatApiError('Chat request was cancelled.'));
    };

    timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, delayMs);

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function ensureChatServiceAwake(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_WAKE_TIMEOUT_MS : opts.timeoutMs;
  const attempts = opts.attempts === undefined ? DEFAULT_WAKE_ATTEMPTS : opts.attempts;
  const retryDelayMs = opts.retryDelayMs === undefined
    ? DEFAULT_WAKE_RETRY_DELAY_MS
    : opts.retryDelayMs;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    try {
      return await checkChatService(Object.assign({}, opts, { timeoutMs: remainingMs }));
    } catch (error) {
      lastError = error;
      if (!error || !error.retryable || attempt + 1 >= Math.max(1, attempts)) throw error;

      const remainingAfterAttempt = deadline - Date.now();
      if (remainingAfterAttempt <= 0) break;
      await waitForRetry(Math.min(retryDelayMs * (attempt + 1), remainingAfterAttempt), opts.signal);
    }
  }

  throw new ChatApiError('Chat service did not wake up in time.', {
    statusCode: lastError && lastError.statusCode,
    retryAfter: lastError && lastError.retryAfter,
    requestId: lastError && lastError.requestId
  });
}

function requestChat(messages, options) {
  const opts = options || {};
  const onActivity = typeof opts.onActivity === 'function' ? opts.onActivity : null;
  const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
  const streaming = Boolean(onActivity || onDelta);
  const endpointValue = opts.endpoint || process.env.OTEKIN_CHAT_API_URL || DEFAULT_CHAT_API_URL;
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
  const maxResponseBytes = opts.maxResponseBytes === undefined
    ? MAX_RESPONSE_BYTES
    : opts.maxResponseBytes;
  const signal = opts.signal;

  if (signal && signal.aborted) {
    return Promise.reject(new ChatApiError('Chat request was cancelled.'));
  }

  let endpoint;
  try {
    endpoint = parseHttpEndpoint(endpointValue, 'Chat service');
  } catch (error) {
    return Promise.reject(error);
  }

  // Omitting `research` selects the gateway's default `auto` research behavior.
  const payload = JSON.stringify({ messages, stream: streaming });
  const transport = endpoint.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let timer;
    // Whether the question could have reached the service. No request bytes leave before the TCP
    // connection (for HTTPS, the TLS handshake) is established; a reused keep-alive socket counts.
    let connected = false;

    const onAbort = () => {
      if (request) request.destroy();
      settle(reject, new ChatApiError('Chat request was cancelled.'));
    };

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      callback(value);
    };

    timer = setTimeout(() => {
      if (request) request.destroy();
      settle(reject, new ChatApiError('Chat service took too long.', { notSent: !connected }));
    }, timeoutMs);

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

    request = transport.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: streaming ? 'application/x-ndjson, application/json' : 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (response) => {
      const statusCode = response.statusCode || 0;
      const headers = response.headers;
      const chunks = [];
      let responseBytes = 0;
      const ndjson = streaming && statusCode >= 200 && statusCode < 300 &&
        /^application\/x-ndjson\b/i.test(headers['content-type'] || '');
      const decoder = new StringDecoder('utf8');
      let pending = '';

      const fail = (message) => {
        settle(reject, new ChatApiError(message, errorDetails(statusCode, headers)));
        response.destroy();
      };
      const acceptReply = (data) => {
        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            typeof data.message !== 'string' || !data.message.trim()) {
          fail('Chat service returned an invalid response.');
          return;
        }
        settle(resolve, data);
      };
      const readEvent = (line) => {
        if (!line.trim() || settled) return;
        if (Buffer.byteLength(line) > maxResponseBytes) {
          fail('Chat service response was too large.');
          return;
        }
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          fail('Chat service returned invalid stream data.');
          return;
        }
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
          fail('Chat service returned invalid stream data.');
          return;
        }
        if (event.type === 'tool') {
          const activity = event.activity;
          if (onActivity && activity && typeof activity.id === 'string' &&
              typeof activity.query === 'string' &&
              ['running', 'complete', 'error'].includes(activity.status)) {
            onActivity(activity);
          }
        } else if (event.type === 'delta') {
          // Deltas are provisional: done.message contains the final citations and images.
          if (onDelta && typeof event.text === 'string') onDelta(event.text);
        } else if (event.type === 'error') {
          // Never print a provider's raw error, even inside an HTTP 200 stream.
          const error = responseError(502, headers, event);
          error.statusCode = statusCode;
          settle(reject, error);
          response.destroy();
        } else if (event.type === 'done') {
          const reply = { ...event };
          delete reply.type;
          acceptReply(reply);
          response.destroy();
        }
        // Unknown event types are deliberately ignored for forward compatibility.
      };
      const readLines = (text) => {
        pending += text;
        let newline;
        while (!settled && (newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          readEvent(line);
        }
        if (!settled && pending.length > maxResponseBytes) {
          fail('Chat service response was too large.');
        }
      };

      response.on('data', (chunk) => {
        if (settled) return;
        responseBytes += chunk.length;
        // A streamed image may occur in both a delta and the canonical done event.
        if (responseBytes > maxResponseBytes * (ndjson ? 2 : 1)) {
          response.destroy();
          settle(reject, new ChatApiError(
            'Chat service response was too large.',
            errorDetails(statusCode, headers)
          ));
          return;
        }
        if (ndjson) {
          try {
            readLines(decoder.write(chunk));
          } catch {
            fail('Unable to process chat service activity.');
          }
        } else {
          chunks.push(chunk);
        }
      });

      response.on('end', () => {
        if (settled) return;
        if (ndjson) {
          try {
            readLines(decoder.end());
            readEvent(pending);
          } catch {
            fail('Unable to process chat service activity.');
          }
          if (!settled) fail('Chat service stream ended before completion.');
          return;
        }

        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          if (statusCode < 200 || statusCode >= 300) {
            settle(reject, responseError(statusCode, headers, null));
            return;
          }
          settle(reject, new ChatApiError(
            'Chat service returned invalid JSON.',
            errorDetails(statusCode, headers)
          ));
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          settle(reject, responseError(statusCode, headers, data));
          return;
        }

        acceptReply(data);
      });

      response.on('error', () => {
        settle(reject, new ChatApiError(
          'Unable to read the chat service response.',
          errorDetails(statusCode, headers)
        ));
      });
    });

    request.on('socket', (socket) => {
      if (request.reusedSocket) {
        connected = true;
        return;
      }
      socket.once(endpoint.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        connected = true;
      });
    });

    request.on('error', () => {
      settle(reject, new ChatApiError('Unable to reach chat service.', { notSent: !connected }));
    });

    request.end(payload);
  });
}

module.exports = {
  DEFAULT_CHAT_API_URL,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARACTERS,
  MAX_TOTAL_CHARACTERS,
  TRIMMED_CONTEXT_NOTICE,
  MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_HEALTH_RESPONSE_BYTES,
  DEFAULT_WAKE_TIMEOUT_MS,
  DEFAULT_WAKE_ATTEMPTS,
  DEFAULT_WAKE_RETRY_DELAY_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  checkChatService,
  probeChatService,
  ensureChatServiceAwake,
  requestChat,
  prepareRequestMessages,
  omittedTurns,
  assistantMessageFromResponse,
  ChatApiError
};
