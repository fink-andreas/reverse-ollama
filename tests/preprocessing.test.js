import { describe, expect, it } from 'vitest';
import {
  extractSegments,
  extractJsonBlocks,
  allNonJsonLinesMatch,
  applyPreprocessing,
} from '../src/preprocessing.js';

describe('extractSegments', () => {
  it('handles empty text', () => {
    expect(extractSegments('')).toEqual([]);
  });

  it('handles simple text', () => {
    const result = extractSegments('Hello\nWorld');
    expect(result.length).toBe(2);
    expect(result[0].text).toBe('Hello');
    expect(result[0].isJson).toBe(false);
    expect(result[1].text).toBe('World');
    expect(result[1].isJson).toBe(false);
  });

  it('detects JSON objects', () => {
    const result = extractSegments('{"key": "value"}');
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('{"key": "value"}');
    expect(result[0].isJson).toBe(true);
  });

  it('detects JSON arrays', () => {
    const result = extractSegments('[1, 2, 3]');
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('[1, 2, 3]');
    expect(result[0].isJson).toBe(true);
  });

  it('handles mixed content', () => {
    const result = extractSegments('Hello\n{"data": 123}\nWorld');
    expect(result.length).toBe(3);
    expect(result[0].isJson).toBe(false);
    expect(result[1].isJson).toBe(true);
    expect(result[2].isJson).toBe(false);
  });

  it('detects JSON with leading whitespace', () => {
    const result = extractSegments('  {"key": "value"}');
    expect(result.length).toBe(1);
    expect(result[0].isJson).toBe(true);
  });
});

describe('extractJsonBlocks', () => {
  it('returns empty array for no JSON', () => {
    expect(extractJsonBlocks('Hello\nWorld')).toEqual([]);
  });

  it('extracts single JSON block', () => {
    expect(extractJsonBlocks('Hello\n{"data": 123}\nWorld')).toEqual(['{"data": 123}']);
  });

  it('extracts multiple JSON blocks', () => {
    expect(extractJsonBlocks('Text\n{"a": 1}\nMore text\n[1, 2]')).toEqual(['{"a": 1}', '[1, 2]']);
  });
});

describe('allNonJsonLinesMatch', () => {
  it('returns false for no patterns', () => {
    expect(allNonJsonLinesMatch('Hello', [])).toBe(false);
  });

  it('returns true when all lines match all patterns', () => {
    // Each line must match ALL patterns
    const patterns = [/Hello/, /World/];
    expect(allNonJsonLinesMatch('Hello World\nHello World', patterns)).toBe(true);
  });

  it('returns false when a line does not match all patterns', () => {
    // "Hello" matches first pattern but not second
    const patterns = [/Hello/, /World/];
    expect(allNonJsonLinesMatch('Hello\nHello World', patterns)).toBe(false);
  });

  it('skips JSON lines', () => {
    const patterns = [/Hello/];
    // Only "Hello" needs to match, JSON is skipped
    expect(allNonJsonLinesMatch('Hello\n{"data": 123}', patterns)).toBe(true);
  });

  it('treats empty lines as matching', () => {
    const patterns = [/Hello/];
    expect(allNonJsonLinesMatch('Hello\n\n', patterns)).toBe(true);
  });

  it('allows single pattern to match multiple lines', () => {
    const patterns = [/^Line \d+$/];
    expect(allNonJsonLinesMatch('Line 1\nLine 2\nLine 3', patterns)).toBe(true);
  });

  it('requires each line to match all patterns', () => {
    // Both lines must match both patterns
    const patterns = [/Line/, /\d+/];
    expect(allNonJsonLinesMatch('Line 1\nLine 2', patterns)).toBe(true);
  });

  it('fails when a line matches only some patterns', () => {
    // "Line X" matches /Line/ but not /\d+/
    const patterns = [/Line/, /\d+/];
    expect(allNonJsonLinesMatch('Line 1\nLine X', patterns)).toBe(false);
  });
});

describe('applyPreprocessing', () => {
  it('handles null body', () => {
    const result = applyPreprocessing(null, { promptReplaces: [] });
    expect(result.requestBody).toBeNull();
    expect(result.appliedRules).toEqual([]);
  });

  it('handles missing config', () => {
    const body = { messages: [{ role: 'user', content: 'Hello' }] };
    const result = applyPreprocessing(body, null);
    expect(result.requestBody).toEqual(body);
    expect(result.appliedRules).toEqual([]);
  });

  it('handles empty promptReplaces', () => {
    const body = { messages: [{ role: 'user', content: 'Hello' }] };
    const result = applyPreprocessing(body, { promptReplaces: [] });
    expect(result.requestBody).toEqual(body);
    expect(result.appliedRules).toEqual([]);
  });

  it('applies matching rule', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hello World' }],
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          match: ['Hello.*'],
          replace: ['Replaced!'],
          compiledPatterns: [/Hello.*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe('Replaced!');
    expect(result.appliedRules).toEqual(['test-rule']);
  });

  it('does not apply non-matching rule', () => {
    const body = {
      messages: [{ role: 'user', content: 'Different content' }],
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          match: ['Hello.*'],
          replace: ['Replaced!'],
          compiledPatterns: [/Hello.*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe('Different content');
    expect(result.appliedRules).toEqual([]);
  });

  it('preserves JSON blocks', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hello World\n{"data": 123}' }],
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          match: ['Hello.*'],
          replace: ['Replaced!'],
          compiledPatterns: [/Hello.*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe('Replaced!\n{"data": 123}');
    expect(result.appliedRules).toEqual(['test-rule']);
  });

  it('only processes user messages', () => {
    const body = {
      messages: [
        { role: 'assistant', content: 'Hello World' },
        { role: 'user', content: 'Hello World' },
      ],
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          match: ['Hello.*'],
          replace: ['Replaced!'],
          compiledPatterns: [/Hello.*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe('Hello World'); // assistant unchanged
    expect(result.requestBody.messages[1].content).toBe('Replaced!'); // user replaced
    expect(result.appliedRules).toEqual(['test-rule']);
  });

  it('works on prompt field', () => {
    const body = {
      prompt: 'Hello World',
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          match: ['Hello.*'],
          replace: ['Replaced!'],
          compiledPatterns: [/Hello.*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.prompt).toBe('Replaced!');
    expect(result.appliedRules).toEqual(['test-rule']);
  });

  it('works on input field', () => {
    const body = {
      input: 'Hello World',
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          match: ['Hello.*'],
          replace: ['Replaced!'],
          compiledPatterns: [/Hello.*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.input).toBe('Replaced!');
    expect(result.appliedRules).toEqual(['test-rule']);
  });

  it('requires all lines to match all patterns', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hello\nWorld' }],
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          // Both lines must match BOTH patterns
          match: ['Hello', 'World'],
          replace: ['Replaced!'],
          compiledPatterns: [/Hello/, /World/],
        },
      ],
    };

    // "Hello" doesn't match /World/, so replacement won't happen
    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe('Hello\nWorld');
    expect(result.appliedRules).toEqual([]);
  });

  it('matches when all lines match all patterns', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hello World\nHello World' }],
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          // Each line must match both /Hello/ and /World/
          match: ['Hello', 'World'],
          replace: ['Replaced!'],
          compiledPatterns: [/Hello/, /World/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe('Replaced!');
    expect(result.appliedRules).toEqual(['test-rule']);
  });

  it('supports multiple replacement lines', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hello World' }],
    };
    const config = {
      promptReplaces: [
        {
          id: 'test-rule',
          match: ['Hello.*'],
          replace: ['Line 1', 'Line 2', 'Line 3'],
          compiledPatterns: [/Hello.*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe('Line 1\nLine 2\nLine 3');
    expect(result.appliedRules).toEqual(['test-rule']);
  });

  it('applies first matching rule only', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hello World' }],
    };
    const config = {
      promptReplaces: [
        {
          id: 'first-rule',
          match: ['Hello.*'],
          replace: ['First!'],
          compiledPatterns: [/Hello.*/],
        },
        {
          id: 'second-rule',
          match: ['Hello.*'],
          replace: ['Second!'],
          compiledPatterns: [/Hello.*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe('First!');
    expect(result.appliedRules).toEqual(['first-rule']);
  });

  it('handles real-world example with single broad pattern', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content:
            'Antworte sachlich, präzise, zielführend und kurz.\n' +
            'Nutze als Antwort-Sprache bitte ausschließlich "German".\n' +
            '{"context": "some data"}',
        },
      ],
    };
    const config = {
      promptReplaces: [
        {
          id: 'replace_messy_summarization',
          // Single pattern that matches both lines (each line must match this pattern)
          match: ['^(Antworte|Nutze).*'],
          replace: ['== Header ==', 'Summarize the following:'],
          compiledPatterns: [/^(Antworte|Nutze).*/],
        },
      ],
    };

    const result = applyPreprocessing(body, config);
    expect(result.requestBody.messages[0].content).toBe(
      '== Header ==\nSummarize the following:\n{"context": "some data"}'
    );
    expect(result.appliedRules).toEqual(['replace_messy_summarization']);
  });
});
