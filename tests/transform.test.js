import { describe, expect, it, beforeAll } from 'vitest';
import { applyActions, ensureDeduplicationConfigLoaded, resetDeduplicationConfig } from '../src/transform.js';

describe('applyActions', () => {
  beforeAll(async () => {
    await ensureDeduplicationConfigLoaded();
  });

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

  it('removes duplicate prefix patterns from config while keeping first occurrence', () => {
    // This test uses the german-technical-instructions pattern from deduplication.json
    // Pattern uses actual CRLF (\r\n) characters
    const prefixPattern = [
      'Antworte sachlich, präzise, zielführend und kurz.',
      'Der Leser ist technisch versiert und kann mit fachlichen Ausdrücken gut umgehen.',
      'Deine Antworten sind dem Leser entsprechend gekennzeichnet, du musst keine Einleitung geben und auch nicht das Eingabeformat beschreiben.',
      'Formatiere deine Antwort in mehrere Zeilen übersichtlich, nutze die Breite von DIN-A4.',
      'Nutze als Antwort-Sprache bitte ausschließlich "German".',
      'Ich liefere dir alle Informationen zu diesem Kontext am Ende als JSON formatiert.',
      'Die darin enthaltenen Nachrichten zwischen uns und dem Kunden sind in chronoligischer Rheienfolge sortiert.',
      '',
      'Generie deine gesamte Antwort einmal in der zuvor definierten Sprache und einmal Englisch, nutze einen Trennstrich mit 25 Minus-zeichen und Umbrüchen zwischen den Sprachen. Den Namen der jeweiligen Sprache eingeschloßen in 2 Gleichheitszeichen und einem Leerzeichen angebeben.',
    ].join('\r\n') + '\r\n';

    const contentWithDuplicates = prefixPattern + 'Some user text\r\n' + prefixPattern + 'More text';

    const result = applyActions({
      requestBody: { prompt: contentWithDuplicates },
      category: { actions: { deduplication: true } },
    });

    // The duplicate prefix pattern should be removed
    expect(result.requestBody.prompt).not.toContain('Some user text\r\nAntworte sachlich');
    expect(result.requestBody.prompt).toContain('Some user text');
    expect(result.requestBody.prompt).toContain('More text');
    expect(result.appliedActions).toContain('deduplicate:text');
    expect(result.appliedActions.some(a => a.startsWith('deduplicate:prefix:'))).toBe(true);
  });

  it('correctly removes multiple duplicate pattern occurrences without corrupting text', () => {
    // Uses the german-technical-instructions pattern from config with 3 occurrences
    const prefixPattern = [
      'Antworte sachlich, präzise, zielführend und kurz.',
      'Der Leser ist technisch versiert und kann mit fachlichen Ausdrücken gut umgehen.',
      'Deine Antworten sind dem Leser entsprechend gekennzeichnet, du musst keine Einleitung geben und auch nicht das Eingabeformat beschreiben.',
      'Formatiere deine Antwort in mehrere Zeilen übersichtlich, nutze die Breite von DIN-A4.',
      'Nutze als Antwort-Sprache bitte ausschließlich "German".',
      'Ich liefere dir alle Informationen zu diesem Kontext am Ende als JSON formatiert.',
      'Die darin enthaltenen Nachrichten zwischen uns und dem Kunden sind in chronoligischer Rheienfolge sortiert.',
      '',
      'Generie deine gesamte Antwort einmal in der zuvor definierten Sprache und einmal Englisch, nutze einen Trennstrich mit 25 Minus-zeichen und Umbrüchen zwischen den Sprachen. Den Namen der jeweiligen Sprache eingeschloßen in 2 Gleichheitszeichen und einem Leerzeichen angebeben.',
    ].join('\r\n') + '\r\n';

    // 3 occurrences of the pattern
    const content = prefixPattern + 'Task 1\r\n' + prefixPattern + 'Task 2\r\n' + prefixPattern + 'JSON data';

    const result = applyActions({
      requestBody: { prompt: content },
      category: { actions: { deduplication: true } },
    });

    // Should keep first occurrence and all content between patterns
    expect(result.requestBody.prompt).toContain('Antworte sachlich');
    expect(result.requestBody.prompt).toContain('Task 1');
    expect(result.requestBody.prompt).toContain('Task 2');
    expect(result.requestBody.prompt).toContain('JSON data');

    // Count occurrences of the pattern start - should be exactly 1
    const occurrences = result.requestBody.prompt.split('Antworte sachlich').length - 1;
    expect(occurrences).toBe(1);
  });

  it('sets model parameters directly on request body', () => {
    const category = {
      actions: {
        parameters: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: 2048,
        },
      },
    };

    const input = {
      model: 'qwen3.5:35b',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = applyActions({ requestBody: input, category });

    expect(result.requestBody.temperature).toBe(0.7);
    expect(result.requestBody.top_p).toBe(0.9);
    expect(result.requestBody.num_predict).toBe(2048);
    expect(result.requestBody.model).toBe('qwen3.5:35b');
    expect(result.appliedActions).toContain('set:parameters:temperature,top_p,num_predict');
  });

  it('overwrites existing parameters when specified in action', () => {
    const category = {
      actions: {
        parameters: {
          temperature: 0.3,
          seed: 42,
        },
      },
    };

    const input = {
      model: 'llama3',
      temperature: 0.8,
      seed: 123,
      prompt: 'test',
    };

    const result = applyActions({ requestBody: input, category });

    expect(result.requestBody.temperature).toBe(0.3);
    expect(result.requestBody.seed).toBe(42);
    expect(result.requestBody.model).toBe('llama3');
    expect(result.appliedActions).toContain('set:parameters:temperature,seed');
  });

  it('applies parameters alongside other actions', () => {
    const category = {
      actions: {
        model: 'qwen3.5:35b',
        num_ctx: 16384,
        parameters: {
          temperature: 0.5,
          top_k: 40,
        },
      },
    };

    const input = {
      model: 'deepseek',
      prompt: 'test',
    };

    const result = applyActions({ requestBody: input, category });

    expect(result.requestBody.model).toBe('qwen3.5:35b');
    expect(result.requestBody.options.num_ctx).toBe(16384);
    expect(result.requestBody.temperature).toBe(0.5);
    expect(result.requestBody.top_k).toBe(40);
    expect(result.appliedActions).toContain('replace:model');
    expect(result.appliedActions).toContain('set:options.num_ctx');
    expect(result.appliedActions).toContain('set:parameters:temperature,top_k');
  });

  it('handles empty parameters object', () => {
    const category = {
      actions: {
        parameters: {},
      },
    };

    const input = { model: 'test', prompt: 'hello' };
    const result = applyActions({ requestBody: input, category });

    expect(result.requestBody).toEqual(input);
    // Empty object should not add an action entry
    expect(result.appliedActions).not.toContain('set:parameters:');
  });

  it('sets parameters for chat completions format', () => {
    const category = {
      actions: {
        parameters: {
          temperature: 0.6,
          max_tokens: 1024,
          presence_penalty: 0.5,
        },
      },
    };

    const input = {
      model: 'qwen3.5:35b',
      store: false,
      user: 'user',
      messages: [
        { role: 'user', content: 'Antworte sachlich...' },
      ],
      n: 1,
    };

    const result = applyActions({ requestBody: input, category });

    expect(result.requestBody.temperature).toBe(0.6);
    expect(result.requestBody.max_tokens).toBe(1024);
    expect(result.requestBody.presence_penalty).toBe(0.5);
    expect(result.requestBody.store).toBe(false);
    expect(result.requestBody.n).toBe(1);
    expect(result.appliedActions).toContain('set:parameters:temperature,max_tokens,presence_penalty');
  });
});
