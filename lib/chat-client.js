'use strict';

const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');

const DEFAULT_CHAT_API_URL = 'https://signloop-chat-api.onrender.com/v1/chat';
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARACTERS = 4000;
const MAX_TOTAL_CHARACTERS = 60000;
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
const RESEARCH_MODES = Object.freeze(['auto', 'always', 'never']);
const SAFE_ERROR_CODES = new Set([
  'invalid_request',
  'research_unavailable',
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
    throw new ChatApiError(`${label} URL is invalid.`);
  }

  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new ChatApiError(`${label} URL must use HTTP or HTTPS.`);
  }
  return endpoint;
}

function normalizeResearchMode(value) {
  if (value === undefined) return 'auto';
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!RESEARCH_MODES.includes(mode)) {
    throw validationError('Research mode must be auto, always, or never.');
  }
  return mode;
}

function compactImages(text) {
  return text
    .replace(/!\[([^\]]*)\]\(\s*data:image\/[a-z0-9.+-]+;base64,[^)]+\)/gi,
      (_match, alt) => `[generated image${alt.trim() ? `: ${alt.trim()}` : ''}]`)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{200,}/gi, '[generated image data]');
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

function requestBytes(messages) {
  return Buffer.byteLength(JSON.stringify({ messages, stream: false, research: 'always' }));
}

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
  if (details.code === 'research_unavailable') {
    return new ChatApiError(
      'Grounded web research is temporarily unavailable. Try again or use --research never.',
      details
    );
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

function checkChatService(options) {
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
      settle(reject, new ChatApiError('Chat service took too long to wake up.', {
        retryable: true
      }));
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

        settle(resolve, data);
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
  const streaming = typeof opts.onActivity === 'function';
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
  let researchMode;
  try {
    endpoint = parseHttpEndpoint(endpointValue, 'Chat service');
    researchMode = normalizeResearchMode(opts.researchMode);
  } catch (error) {
    return Promise.reject(error);
  }

  const payload = JSON.stringify({ messages, stream: streaming, research: researchMode });
  const transport = endpoint.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let timer;

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
      settle(reject, new ChatApiError('Chat service took too long.'));
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
          if (activity && typeof activity.id === 'string' &&
              typeof activity.query === 'string' &&
              ['running', 'complete', 'error'].includes(activity.status)) {
            opts.onActivity(activity);
          }
        } else if (event.type === 'error') {
          // Never print a provider's raw error, even inside an HTTP 200 stream.
          const error = responseError(502, headers, event);
          error.statusCode = statusCode;
          settle(reject, error);
          response.destroy();
        } else if (event.type === 'done') {
          const { type, ...reply } = event;
          acceptReply(reply);
          response.destroy();
        }
        // Deltas are provisional: done.message contains the final citations and images.
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

    request.on('error', () => {
      settle(reject, new ChatApiError('Unable to reach chat service.'));
    });

    request.end(payload);
  });
}

module.exports = {
  DEFAULT_CHAT_API_URL,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARACTERS,
  MAX_TOTAL_CHARACTERS,
  MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_HEALTH_RESPONSE_BYTES,
  DEFAULT_WAKE_TIMEOUT_MS,
  DEFAULT_WAKE_ATTEMPTS,
  DEFAULT_WAKE_RETRY_DELAY_MS,
  RESEARCH_MODES,
  checkChatService,
  ensureChatServiceAwake,
  normalizeResearchMode,
  requestChat,
  prepareRequestMessages,
  assistantMessageFromResponse,
  ChatApiError
};
