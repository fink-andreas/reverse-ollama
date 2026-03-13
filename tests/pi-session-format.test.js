import { describe, expect, it } from 'vitest';
import { buildPiSession } from '../src/pi-session-format.js';

describe('pi-session-format', () => {
  describe('buildPiSession', () => {
    it('should create a session with header and entries', () => {
      const session = buildPiSession({
        requestId: 'test-123',
        source: '127.0.0.1',
        method: 'POST',
        path: '/api/chat',
        matchedCategory: null,
        appliedActions: [],
        incomingBody: JSON.stringify({
          model: 'llama3',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        outgoingBody: null,
        responseBody: JSON.stringify({
          model: 'llama3',
          message: { role: 'assistant', content: 'Hi there!' },
        }),
        statusCode: 200,
        error: null,
      });

      expect(session.header).toBeDefined();
      expect(session.header.id).toBeDefined();
      expect(session.header.type).toBe('session');
      expect(Array.isArray(session.entries)).toBe(true);
      expect(session.leafId).toBeDefined();
    });

    it('should include user and assistant messages', () => {
      const session = buildPiSession({
        requestId: 'test-123',
        source: '127.0.0.1',
        method: 'POST',
        path: '/api/chat',
        incomingBody: JSON.stringify({
          model: 'llama3',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        responseBody: JSON.stringify({
          model: 'llama3',
          message: { role: 'assistant', content: 'Hi there!' },
        }),
        statusCode: 200,
      });

      const roles = session.entries.map(e => e.message?.role).filter(Boolean);
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
    });

    it('should create reasoning entry from message.reasoning field', () => {
      const session = buildPiSession({
        requestId: 'test-123',
        source: '127.0.0.1',
        method: 'POST',
        path: '/api/chat',
        incomingBody: JSON.stringify({
          model: 'llama3',
          messages: [{ role: 'user', content: 'What is 2+2?' }],
        }),
        responseBody: JSON.stringify({
          model: 'llama3',
          message: {
            role: 'assistant',
            reasoning: 'Thinking: 2+2 equals 4',
            content: 'The answer is 4',
          },
        }),
        statusCode: 200,
      });

      const roles = session.entries.map(e => e.message?.role).filter(Boolean);
      expect(roles).toContain('user');
      expect(roles).toContain('reasoning');
      expect(roles).toContain('assistant');

      // Reasoning should come before assistant
      const reasoningIndex = session.entries.findIndex(e => e.message?.role === 'reasoning');
      const assistantIndex = session.entries.findIndex(e => e.message?.role === 'assistant');
      expect(reasoningIndex).toBeLessThan(assistantIndex);

      // Check reasoning content
      const reasoningEntry = session.entries.find(e => e.message?.role === 'reasoning');
      expect(reasoningEntry.message.content[0].thinking).toBe('Thinking: 2+2 equals 4');
    });

    it('should create reasoning entry from OpenAI choices format', () => {
      const session = buildPiSession({
        requestId: 'test-123',
        source: '127.0.0.1',
        method: 'POST',
        path: '/v1/chat/completions',
        incomingBody: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        responseBody: JSON.stringify({
          model: 'gpt-4',
          choices: [{
            message: {
              role: 'assistant',
              reasoning: 'Let me think about this...',
              content: 'Hello! How can I help?',
            },
            finish_reason: 'stop',
          }],
        }),
        statusCode: 200,
      });

      const roles = session.entries.map(e => e.message?.role).filter(Boolean);
      expect(roles).toContain('reasoning');

      const reasoningEntry = session.entries.find(e => e.message?.role === 'reasoning');
      expect(reasoningEntry.message.content[0].thinking).toBe('Let me think about this...');
    });

    it('should not create reasoning entry when not present', () => {
      const session = buildPiSession({
        requestId: 'test-123',
        source: '127.0.0.1',
        method: 'POST',
        path: '/api/chat',
        incomingBody: JSON.stringify({
          model: 'llama3',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        responseBody: JSON.stringify({
          model: 'llama3',
          message: { role: 'assistant', content: 'Hi there!' },
        }),
        statusCode: 200,
      });

      const roles = session.entries.map(e => e.message?.role).filter(Boolean);
      expect(roles).not.toContain('reasoning');
    });

    it('should handle inline thinking content (reasoning_content)', () => {
      const session = buildPiSession({
        requestId: 'test-123',
        source: '127.0.0.1',
        method: 'POST',
        path: '/v1/chat/completions',
        incomingBody: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        responseBody: JSON.stringify({
          model: 'gpt-4',
          choices: [{
            message: {
              role: 'assistant',
              reasoning_content: 'Internal thinking...',
              content: 'Hello!',
            },
            finish_reason: 'stop',
          }],
        }),
        statusCode: 200,
      });

      // reasoning_content should be inline as 'thinking' type, not separate reasoning entry
      const roles = session.entries.map(e => e.message?.role).filter(Boolean);
      expect(roles).not.toContain('reasoning');

      // But should have thinking content in assistant message
      const assistantEntry = session.entries.find(e => e.message?.role === 'assistant');
      const thinkingContent = assistantEntry.message.content.find(c => c.type === 'thinking');
      expect(thinkingContent).toBeDefined();
      expect(thinkingContent.thinking).toBe('Internal thinking...');
    });

    it('should map request-side assistant tool calls and tool results', () => {
      const session = buildPiSession({
        requestId: 'test-tools',
        source: '127.0.0.1',
        method: 'POST',
        path: '/v1/chat/completions',
        incomingBody: JSON.stringify({
          model: 'qwen',
          messages: [
            { role: 'user', content: 'what is IPVA?' },
            {
              role: 'assistant',
              content: null,
              reasoning: 'Need to search docs',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: '{"command":"rg -i ipva ."}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_1',
              content: 'match found',
              name: 'bash',
            },
          ],
        }),
        responseBody: JSON.stringify({
          model: 'qwen',
          choices: [{ message: { role: 'assistant', content: 'IPVA is ...' }, finish_reason: 'stop' }],
        }),
        statusCode: 200,
      });

      const requestAssistant = session.entries.find((e) => e.message?.role === 'assistant' && e.message?.tool_calls);
      expect(requestAssistant).toBeDefined();
      expect(requestAssistant.message.reasoning).toBe('Need to search docs');
      expect(requestAssistant.message.tool_calls[0].id).toBe('call_1');

      const toolResult = session.entries.find((e) => e.message?.role === 'toolResult');
      expect(toolResult).toBeDefined();
      expect(toolResult.message.toolCallId).toBe('call_1');
      expect(toolResult.message.toolName).toBe('bash');
      expect(toolResult.message.content[0].text).toBe('match found');
    });

    it('should include proxy metadata', () => {
      const session = buildPiSession({
        requestId: 'test-123',
        source: '192.168.1.1',
        method: 'POST',
        path: '/api/chat',
        matchedCategory: 'coding',
        appliedActions: ['model-replace'],
        incomingBody: '{"model":"test"}',
        outgoingBody: '{"model":"codellama"}',
        responseBody: '{"message":{"content":"ok"}}',
        statusCode: 200,
        durationMs: 150,
      });

      expect(session._proxy).toBeDefined();
      expect(session._proxy.requestId).toBe('test-123');
      expect(session._proxy.source).toBe('192.168.1.1');
      expect(session._proxy.method).toBe('POST');
      expect(session._proxy.path).toBe('/api/chat');
      expect(session._proxy.matchedCategory).toBe('coding');
      expect(session._proxy.appliedActions).toEqual(['model-replace']);
      expect(session._proxy.statusCode).toBe(200);
      expect(session._proxy.durationMs).toBe(150);
    });
  });
});
