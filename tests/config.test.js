import { describe, expect, it } from 'vitest';
import { normalizeConfig, validateConfig } from '../src/config.js';

describe('config validation', () => {
  it('accepts a valid config', () => {
    const config = {
      categories: [
        {
          name: 'coding',
          endpoints: ['/api/chat'],
          match: { messagesRegex: 'code|debug', flags: 'i' },
          actions: { model: 'codellama:latest', num_ctx: 8192 },
        },
      ],
    };

    expect(() => validateConfig(config, 'inline')).not.toThrow();

    const normalized = normalizeConfig(config);
    expect(normalized.categories[0].compiledMatchers.messagesRegex).toBeInstanceOf(RegExp);
  });

  it('rejects invalid regex', () => {
    const config = {
      categories: [
        {
          name: 'bad',
          match: { modelRegex: '[unterminated' },
        },
      ],
    };

    expect(() => normalizeConfig(config)).toThrow(/Invalid modelRegex/);
  });
});
