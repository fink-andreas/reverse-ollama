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
 * Parse SSE streaming response into chunks.
 * Each line starting with "data: " contains a JSON chunk.
 */
function parseSSEResponse(responseBody) {
  const chunks = [];
  const lines = responseBody.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ')) {
      continue;
    }

    const data = trimmed.slice(6); // Remove "data: " prefix
    if (data === '[DONE]') {
      break;
    }

    try {
      const parsed = JSON.parse(data);
      chunks.push(parsed);
    } catch {
      // Skip invalid JSON
    }
  }

  return chunks;
}

/**
 * Check if response body is SSE streaming format.
 */
function isSSEResponse(responseBody) {
  if (typeof responseBody !== 'string') {
    return false;
  }

  const trimmed = responseBody.trim();
  return trimmed.startsWith('data: ');
}

/**
 * Parse OpenAI-compatible chat response body.
 * Handles both non-streaming and SSE streaming responses.
 */
function parseChatResponse(responseBody) {
  if (!responseBody) {
    return { content: [], reasoning: null, model: null, usage: null, stopReason: null, toolCalls: null };
  }

  try {
    // Check for SSE streaming format
    if (typeof responseBody === 'string' && isSSEResponse(responseBody)) {
      return parseStreamingResponse(responseBody);
    }

    const parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;

    // OpenAI format
    if (parsed.choices && Array.isArray(parsed.choices)) {
      const choice = parsed.choices[0];
      const content = [];
      let reasoning = null;

      if (choice?.message?.content) {
        content.push({
          type: 'text',
          text: choice.message.content,
        });
      }

      // Check for reasoning field (creates separate reasoning entry)
      if (choice?.message?.reasoning) {
        reasoning = {
          type: 'thinking',
          thinking: choice.message.reasoning,
        };
      }
      // Also check for reasoning_content / thinking (inline thinking content)
      if (choice?.message?.reasoning_content || choice?.message?.thinking) {
        content.unshift({
          type: 'thinking',
          thinking: choice.message.reasoning_content || choice.message.thinking,
        });
      }

      // Handle tool calls - convert to content parts (pi format)
      if (choice?.message?.tool_calls && Array.isArray(choice.message.tool_calls)) {
        for (const tc of choice.message.tool_calls) {
          let parsedArgs = tc.function?.arguments || '';
          try {
            parsedArgs = JSON.parse(parsedArgs);
          } catch {
            // Keep as string if not valid JSON
          }
          content.push({
            type: 'toolCall',
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: parsedArgs,
          });
        }
      }

      return {
        content,
        reasoning,
        model: parsed.model || null,
        usage: parsed.usage || null,
        stopReason: choice?.finish_reason || 'stop',
        toolCalls: null,  // tool calls are now in content
      };
    }

    // Ollama format
    if (parsed.message) {
      const content = [];
      let reasoning = null;

      if (parsed.message.content) {
        content.push({
          type: 'text',
          text: parsed.message.content,
        });
      }

      // Check for reasoning field in Ollama format
      if (parsed.message.reasoning) {
        reasoning = {
          type: 'thinking',
          thinking: parsed.message.reasoning,
        };
      }

      return {
        content,
        reasoning,
        model: parsed.model || null,
        usage: parsed.eval_count ? {
          input: parsed.prompt_eval_count || 0,
          output: parsed.eval_count || 0,
          totalTokens: (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0),
        } : null,
        stopReason: parsed.done ? 'stop' : null,
        toolCalls: null,
      };
    }

    return { content: [], reasoning: null, model: parsed.model || null, usage: null, stopReason: null, toolCalls: null };
  } catch {
    return { content: [], reasoning: null, model: null, usage: null, stopReason: null, toolCalls: null };
  }
}

/**
 * Parse SSE streaming response and accumulate deltas.
 */
function parseStreamingResponse(responseBody) {
  const chunks = parseSSEResponse(responseBody);

  let contentText = '';
  let reasoningText = '';
  let model = null;
  let stopReason = null;
  let usage = null;
  const toolCallsMap = new Map(); // index -> accumulated tool call

  for (const chunk of chunks) {
    if (chunk.model) {
      model = chunk.model;
    }

    if (chunk.usage) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    if (choice.finish_reason) {
      stopReason = choice.finish_reason;
    }

    const delta = choice.delta;
    if (!delta) {
      continue;
    }

    // Accumulate reasoning
    if (delta.reasoning) {
      reasoningText += delta.reasoning;
    }

    // Accumulate content
    if (delta.content) {
      contentText += delta.content;
    }

    // Handle tool calls in delta
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index ?? 0;

        if (!toolCallsMap.has(index)) {
          toolCallsMap.set(index, {
            id: toolCallDelta.id || '',
            type: toolCallDelta.type || 'function',
            function: {
              name: '',
              arguments: '',
            },
          });
        }

        const existing = toolCallsMap.get(index);

        if (toolCallDelta.id) {
          existing.id = toolCallDelta.id;
        }

        if (toolCallDelta.type) {
          existing.type = toolCallDelta.type;
        }

        if (toolCallDelta.function?.name) {
          existing.function.name = toolCallDelta.function.name;
        }

        if (toolCallDelta.function?.arguments) {
          existing.function.arguments += toolCallDelta.function.arguments;
        }
      }
    }
  }

  const content = [];
  let reasoning = null;

  // Build reasoning entry if present
  if (reasoningText) {
    reasoning = {
      type: 'thinking',
      thinking: reasoningText,
    };
  }

  // Build content
  if (contentText) {
    content.push({
      type: 'text',
      text: contentText,
    });
  }

  // Convert tool calls to content parts (pi format)
  if (toolCallsMap.size > 0) {
    const toolCallsArray = Array.from(toolCallsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => {
        // Parse the arguments string to get the JSON object
        let parsedArgs = tc.function?.arguments || '';
        try {
          parsedArgs = JSON.parse(parsedArgs);
        } catch {
          // Keep as string if not valid JSON
        }
        return {
          type: 'toolCall',
          id: tc.id || '',
          name: tc.function?.name || '',
          arguments: parsedArgs,
        };
      });
    content.push(...toolCallsArray);
  }

  return {
    content,
    reasoning,
    model,
    usage,
    stopReason,
    toolCalls: null,  // tool calls are now in content
  };
}

/**
 * Convert a message from OpenAI/Ollama format to pi content array.
 */
function convertMessageToContent(message) {
  if (!message) {
    return [];
  }

  const content = message.content;

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

function normalizeRequestMessage(msg) {
  const originalRole = msg?.role || 'user';
  const normalizedRole = originalRole === 'tool' ? 'toolResult' : originalRole;
  const message = {
    role: normalizedRole,
    content: convertMessageToContent(msg),
    timestamp: Date.now(),
  };

  if (msg?.name) {
    message.name = msg.name;
  }

  if (normalizedRole === 'assistant' && msg?.reasoning) {
    message.reasoning = msg.reasoning;
  }

  const toolCalls = Array.isArray(msg?.tool_calls)
    ? msg.tool_calls
    : (Array.isArray(msg?.toolCalls) ? msg.toolCalls : null);

  if (normalizedRole === 'assistant' && toolCalls) {
    message.tool_calls = toolCalls;
  }

  if (normalizedRole === 'toolResult') {
    if (msg?.tool_call_id) {
      message.toolCallId = msg.tool_call_id;
    }
    if (msg?.toolCallId) {
      message.toolCallId = msg.toolCallId;
    }
    if (msg?.name) {
      message.toolName = msg.name;
    }
    if (typeof msg?.is_error === 'boolean') {
      message.isError = msg.is_error;
    }
    if (typeof msg?.isError === 'boolean') {
      message.isError = msg.isError;
    }
  }

  return message;
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

  // Add request history messages
  for (const msg of request.messages) {
    const messageEntry = {
      type: 'message',
      id: generateShortId(),
      parentId: lastEntryId,
      timestamp: now,
      message: normalizeRequestMessage(msg),
    };

    entries.push(messageEntry);
    lastEntryId = messageEntry.id;
  }

  // Add reasoning entry if present (before assistant response)
  if (response.reasoning) {
    const reasoningEntry = {
      type: 'message',
      id: generateShortId(),
      parentId: lastEntryId,
      timestamp: now,
      message: {
        role: 'reasoning',
        content: [response.reasoning],
        timestamp: Date.now(),
      },
    };

    entries.push(reasoningEntry);
    lastEntryId = reasoningEntry.id;
  }

  // Add assistant response (even if content is empty, if there are tool calls or reasoning was shown)
  const hasContent = response.content.length > 0;
  const hasToolCalls = response.toolCalls && response.toolCalls.length > 0;
  const reasoningWasAdded = entries.some(e => e.type === 'message' && e.message?.role === 'reasoning');

  if (hasContent || hasToolCalls) {
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

    if (hasToolCalls) {
      assistantEntry.message.toolCalls = response.toolCalls;
    }

    entries.push(assistantEntry);
    lastEntryId = assistantEntry.id;
  } else if (reasoningWasAdded) {
    // If there was reasoning but no content or tool calls, create a minimal assistant entry
    entries.push({
      type: 'message',
      id: generateShortId(),
      parentId: lastEntryId,
      timestamp: now,
      message: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
      },
    });
    lastEntryId = generateShortId();  // Use the id we just created
    const lastEntry = entries[entries.length - 1];
    lastEntryId = lastEntry.id;
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
