/**
 * Pi-compatible session format for reverse-ollama.
 * Transforms HTTP request/response pairs into pi session structure.
 */

import { randomUUID } from 'node:crypto';

/**
 * Generate a short hex ID (8 chars) like pi uses.
 */
function generateShortId() {
  return randomUUID().split('-')[0];
}

/**
 * Parse OpenAI-compatible chat request body to extract messages.
 */
function parseChatRequest(incomingBody) {
  if (!incomingBody) {
    return { messages: [], model: null, options: {} };
  }

  try {
    const parsed = typeof incomingBody === 'string' ? JSON.parse(incomingBody) : incomingBody;
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const model = parsed.model || null;
    const options = parsed.options || {};

    return { messages, model, options };
  } catch {
    return { messages: [], model: null, options: {} };
  }
}

/**
 * Parse OpenAI-compatible chat response body.
 */
function parseChatResponse(responseBody) {
  if (!responseBody) {
    return { content: [], model: null, usage: null, stopReason: null };
  }

  try {
    const parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;

    // OpenAI format
    if (parsed.choices && Array.isArray(parsed.choices)) {
      const choice = parsed.choices[0];
      const content = [];

      if (choice?.message?.content) {
        content.push({
          type: 'text',
          text: choice.message.content,
        });
      }

      // Check for reasoning/thinking content (some providers add this)
      if (choice?.message?.reasoning_content || choice?.message?.thinking) {
        content.unshift({
          type: 'thinking',
          thinking: choice.message.reasoning_content || choice.message.thinking,
        });
      }

      return {
        content,
        model: parsed.model || null,
        usage: parsed.usage || null,
        stopReason: choice?.finish_reason || 'stop',
      };
    }

    // Ollama format
    if (parsed.message) {
      const content = [];
      if (parsed.message.content) {
        content.push({
          type: 'text',
          text: parsed.message.content,
        });
      }
      return {
        content,
        model: parsed.model || null,
        usage: parsed.eval_count ? {
          input: parsed.prompt_eval_count || 0,
          output: parsed.eval_count || 0,
          totalTokens: (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0),
        } : null,
        stopReason: parsed.done ? 'stop' : null,
      };
    }

    return { content: [], model: parsed.model || null, usage: null, stopReason: null };
  } catch {
    return { content: [], model: null, usage: null, stopReason: null };
  }
}

/**
 * Convert a message from OpenAI/Ollama format to pi content array.
 */
function convertMessageToContent(message) {
  if (!message) {
    return [];
  }

  const content = message.content;
  const role = message.role || 'user';

  // String content
  if (typeof content === 'string') {
    return [{
      type: 'text',
      text: content,
    }];
  }

  // Array content (multimodal)
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') {
        return { type: 'text', text: part };
      }
      if (part.type === 'text') {
        return { type: 'text', text: part.text || '' };
      }
      if (part.type === 'image_url' || part.type === 'image') {
        return {
          type: 'image',
          url: part.image_url?.url || part.url || null,
        };
      }
      return part;
    });
  }

  return [];
}

/**
 * Build a pi-compatible session object from proxy request/response data.
 */
export function buildPiSession({
  requestId,
  source,
  method,
  path,
  matchedCategory,
  appliedActions,
  incomingBody,
  outgoingBody,
  responseBody,
  statusCode,
  error,
  durationMs = null,
  timestamp = new Date(),
}) {
  const sessionId = randomUUID();
  const now = timestamp.toISOString();

  // Parse request and response
  const request = parseChatRequest(incomingBody);
  const response = parseChatResponse(responseBody);

  // Build header
  const header = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: now,
    cwd: process.cwd(),
  };

  // Build entries
  const entries = [];
  let lastEntryId = null;

  // Add model change entry if we have a model
  if (request.model || outgoingBody) {
    const modelEntry = {
      type: 'model_change',
      id: generateShortId(),
      parentId: lastEntryId,
      timestamp: now,
    };

    // Try to get model from outgoing body (transformed)
    if (outgoingBody) {
      try {
        const outgoing = typeof outgoingBody === 'string' ? JSON.parse(outgoingBody) : outgoingBody;
        if (outgoing.model) {
          modelEntry.modelId = outgoing.model;
        }
      } catch {
        // ignore
      }
    }

    if (!modelEntry.modelId && request.model) {
      modelEntry.modelId = request.model;
    }

    if (modelEntry.modelId) {
      entries.push(modelEntry);
      lastEntryId = modelEntry.id;
    }
  }

  // Add user messages from request
  for (const msg of request.messages) {
    const role = msg.role || 'user';
    const messageEntry = {
      type: 'message',
      id: generateShortId(),
      parentId: lastEntryId,
      timestamp: now,
      message: {
        role,
        content: convertMessageToContent(msg),
        timestamp: Date.now(),
      },
    };

    // Add original message fields that might be useful
    if (msg.name) {
      messageEntry.message.name = msg.name;
    }

    entries.push(messageEntry);
    lastEntryId = messageEntry.id;
  }

  // Add assistant response
  if (response.content.length > 0) {
    const assistantEntry = {
      type: 'message',
      id: generateShortId(),
      parentId: lastEntryId,
      timestamp: now,
      message: {
        role: 'assistant',
        content: response.content,
        timestamp: Date.now(),
      },
    };

    if (response.model) {
      assistantEntry.message.model = response.model;
    }

    if (response.usage) {
      assistantEntry.message.usage = response.usage;
    }

    if (response.stopReason) {
      assistantEntry.message.stopReason = response.stopReason;
    }

    entries.push(assistantEntry);
    lastEntryId = assistantEntry.id;
  }

  // Add error entry if there was an error
  if (error) {
    const errorEntry = {
      type: 'error',
      id: generateShortId(),
      parentId: lastEntryId,
      timestamp: now,
      error: {
        message: error,
        statusCode,
      },
    };
    entries.push(errorEntry);
    lastEntryId = errorEntry.id;
  }

  // Build complete session
  const session = {
    header,
    entries,
    leafId: lastEntryId,
  };

  // Add proxy metadata (not part of standard pi format, but useful for reverse-ollama)
  session._proxy = {
    requestId,
    source,
    method,
    path,
    matchedCategory,
    appliedActions,
    statusCode,
    durationMs,
    timestamp: now,
    request: {
      incomingBody: incomingBody,
      outgoingBody: outgoingBody,
    },
    response: {
      body: responseBody,
    },
  };

  return session;
}

export default {
  buildPiSession,
};
