import { describe, expect, it } from 'vitest';
import { matchRequestCategory } from '../src/matcher.js';

describe('matchRequestCategory', () => {
  it('matches by endpoint and messages regex', () => {
    const categories = [
      {
        name: 'coding',
        endpoints: ['/api/chat'],
        compiledMatchers: {
          pathRegex: null,
          modelRegex: null,
          promptRegex: null,
          messagesRegex: /code|debug/i,
          rawRegex: null,
        },
      },
    ];

    const result = matchRequestCategory({
      categories,
      requestPath: '/api/chat',
      requestBody: { messages: [{ content: 'please debug this issue' }] },
      rawBodyText: '',
    });

    expect(result?.name).toBe('coding');
  });

  it('returns null when no category matches', () => {
    const categories = [
      {
        name: 'other',
        endpoints: ['/api/generate'],
        compiledMatchers: {
          pathRegex: null,
          modelRegex: /llama3/,
          promptRegex: null,
          messagesRegex: null,
          rawRegex: null,
        },
      },
    ];

    const result = matchRequestCategory({
      categories,
      requestPath: '/api/chat',
      requestBody: { model: 'mistral' },
      rawBodyText: '',
    });

    expect(result).toBeNull();
  });
});
