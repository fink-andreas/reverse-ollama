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

  it('deduplicates duplicate lines when affected characters exceed threshold', () => {
    const duplicateLines = [
      'Antworte sachlich, präzise, zielführend und kurz.',
      'Der Leser ist technisch versiert und kann mit fachlichen Ausdrücken gut umgehen.',
      'Antworte sachlich, präzise, zielführend und kurz.',
    ].join('\\r\\n');

    const category = {
      actions: {
        deduplication: true,
      },
    };

    const input = {
      prompt: duplicateLines,
      messages: [{ role: 'user', content: duplicateLines }],
    };

    const result = applyActions({ requestBody: input, category });

    expect(result.requestBody.prompt).toBe(
      [
        'Antworte sachlich, präzise, zielführend und kurz.',
        'Der Leser ist technisch versiert und kann mit fachlichen Ausdrücken gut umgehen.',
      ].join('\n'),
    );
    expect(result.requestBody.messages[0].content).toBe(result.requestBody.prompt);
    expect(result.appliedActions).toContain('deduplicate:text');
  });

  it('does not deduplicate when affected characters stay below threshold', () => {
    const shortDuplicate = ['Line A', 'Line A'].join('\\n');

    const result = applyActions({
      requestBody: { prompt: shortDuplicate },
      category: { actions: { deduplication: true } },
    });

    expect(result.requestBody.prompt).toBe(shortDuplicate);
    expect(result.appliedActions).not.toContain('deduplicate:text');
  });

  it('keeps bracket/json lines and does not deduplicate when disabled', () => {
    const withJsonAndBracket = [
      '[Externe E-Mail]',
      '[Externe E-Mail]',
      '{"k":"v"}',
      '{"k":"v"}',
      'Line A',
      'Line A',
    ].join('\\n');

    const dedupResult = applyActions({
      requestBody: { prompt: withJsonAndBracket },
      category: { actions: { deduplication: true } },
    });

    expect(dedupResult.requestBody.prompt).toBe(withJsonAndBracket);

    const untouchedResult = applyActions({
      requestBody: { prompt: withJsonAndBracket },
      category: { actions: {} },
    });

    expect(untouchedResult.requestBody.prompt).toBe(withJsonAndBracket);
    expect(untouchedResult.appliedActions).not.toContain('deduplicate:text');
  });
});
