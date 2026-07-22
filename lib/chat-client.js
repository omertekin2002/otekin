'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_CHAT_API_URL = 'https://signloop-chat-api.onrender.com/v1/chat';
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARACTERS = 4000;
const MAX_TOTAL_CHARACTERS = 60000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 200000;

class ChatApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ChatApiError';
    this.statusCode = details && details.statusCode ? details.statusCode : null;
    this.retryAfter = details && details.retryAfter ? details.retryAfter : null;
    this.requestId = details && details.requestId ? details.requestId : null;
  }
}

function validationError(message) {
  return new ChatApiError(message);
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
        {
          role: 'assistant',
          content: item.content.slice(0, MAX_MESSAGE_CHARACTERS)
        }
      );
      pendingUser = null;
    }
  }

  const messages = pairs.concat({ role: 'user', content: prompt });
  let totalCharacters = messages.reduce((total, message) => total + message.content.length, 0);

  while (
    messages.length > MAX_MESSAGES ||
    totalCharacters > MAX_TOTAL_CHARACTERS
  ) {
    if (messages.length < 3) break;
    const removed = messages.splice(0, 2);
    totalCharacters -= removed[0].content.length + removed[1].content.length;
  }

  return messages;
}

function errorDetails(statusCode, headers) {
  return {
    statusCode,
    retryAfter: headers['retry-after'] || null,
    requestId: headers['x-request-id'] || null
  };
}

function responseError(statusCode, headers) {
  const details = errorDetails(statusCode, headers);

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

function requestChat(messages, options) {
  const opts = options || {};
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
    endpoint = new URL(endpointValue);
  } catch {
    return Promise.reject(new ChatApiError('Chat service URL is invalid.'));
  }

  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    return Promise.reject(new ChatApiError('Chat service URL must use HTTP or HTTPS.'));
  }

  const payload = JSON.stringify({ messages, stream: false });
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
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload)
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
            'Chat service response was too large.',
            errorDetails(statusCode, headers)
          ));
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        if (settled) return;

        if (statusCode < 200 || statusCode >= 300) {
          settle(reject, responseError(statusCode, headers));
          return;
        }

        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          settle(reject, new ChatApiError(
            'Chat service returned invalid JSON.',
            errorDetails(statusCode, headers)
          ));
          return;
        }

        if (
          !data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          typeof data.message !== 'string' ||
          !data.message.trim()
        ) {
          settle(reject, new ChatApiError(
            'Chat service returned an invalid response.',
            errorDetails(statusCode, headers)
          ));
          return;
        }

        settle(resolve, data);
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
  requestChat,
  prepareRequestMessages,
  ChatApiError
};
