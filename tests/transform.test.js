import { describe, expect, it } from 'vitest';
import { applyActions } from '../src/transform.js';

describe('applyActions', () => {
  it('replaces model and sets options.num_ctx', () => {
    const category = {
      actions: {
        model: 'codellama:latest',
        num_ctx: 16384,
      },
    };

    const input = { model: 'llama3.2', prompt: 'hello' };
    const result = applyActions({ requestBody: input, category });

    expect(result.requestBody.model).toBe('codellama:latest');
    expect(result.requestBody.options.num_ctx).toBe(16384);
    expect(result.appliedActions).toContain('replace:model');
    expect(result.appliedActions).toContain('set:options.num_ctx');
  });
});
