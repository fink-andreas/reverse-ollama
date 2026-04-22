import { describe, expect, it } from 'vitest';
import { checkSkipPatterns } from '../src/session-skip.js';

describe('checkSkipPatterns', () => {
  it('returns skipped:false when patterns is empty', () => {
    const result = checkSkipPatterns({ messages: [] }, []);
    expect(result.skipped).toBe(false);
    expect(result.logSkipped).toBe(false);
  });

  it('returns skipped:false when patterns is null', () => {
    const result = checkSkipPatterns({ messages: [] }, null);
    expect(result.skipped).toBe(false);
    expect(result.logSkipped).toBe(false);
  });

  it('returns skipped:false when requestBody is null', () => {
    const result = checkSkipPatterns(null, [{ pattern: 'foo' }]);
    expect(result.skipped).toBe(false);
  });

  it('returns skipped:false when requestBody has no messages', () => {
    const result = checkSkipPatterns({}, [{ pattern: 'foo' }]);
    expect(result.skipped).toBe(false);
  });

  it('returns skipped:false when messages array is empty', () => {
    const result = checkSkipPatterns({ messages: [] }, [{ pattern: 'foo' }]);
    expect(result.skipped).toBe(false);
  });

  it('matches a single pattern against system message with startsWith', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are an expert coding assistant operating inside pi, hello world' },
      ],
    };
    const patterns = [{ pattern: 'You are an expert coding assistant operating inside pi,', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(true);
    expect(result.logSkipped).toBe(false);
  });

  it('does not match if system message content does not start with pattern', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
      ],
    };
    const patterns = [{ pattern: 'You are an expert coding assistant operating inside pi,', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(false);
  });

  it('requires all patterns to match (AND logic)', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are an expert coding assistant operating inside pi, hello' },
        { role: 'system', content: 'Another system message' },
      ],
    };
    const patterns = [
      { pattern: 'You are an expert coding assistant operating inside pi,', log: false },
      { pattern: 'Another system message', log: false },
    ];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(true);
  });

  it('fails if one pattern does not match any message', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are an expert coding assistant operating inside pi, hello' },
      ],
    };
    const patterns = [
      { pattern: 'You are an expert coding assistant operating inside pi,', log: false },
      { pattern: 'This pattern does not exist', log: false },
    ];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(false);
  });

  it('returns logSkipped:true when any pattern has log:true', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are an expert coding assistant operating inside pi, hello' },
      ],
    };
    const patterns = [
      { pattern: 'You are an expert coding assistant operating inside pi,', log: true },
    ];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(true);
    expect(result.logSkipped).toBe(true);
  });

  it('returns logSkipped:false when no pattern has log:true', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are an expert coding assistant operating inside pi, hello' },
      ],
    };
    const patterns = [
      { pattern: 'You are an expert coding assistant operating inside pi,', log: false },
    ];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(true);
    expect(result.logSkipped).toBe(false);
  });

  it('skips non-system messages when matching', () => {
    const body = {
      messages: [
        { role: 'user', content: 'You are an expert coding assistant operating inside pi, hello' },
        { role: 'system', content: 'You are an expert coding assistant operating inside pi, actual system' },
      ],
    };
    const patterns = [{ pattern: 'You are an expert coding assistant operating inside pi,', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(true);
  });

  it('does not match if only user messages contain the pattern', () => {
    const body = {
      messages: [
        { role: 'user', content: 'You are an expert coding assistant operating inside pi, hello' },
      ],
    };
    const patterns = [{ pattern: 'You are an expert coding assistant operating inside pi,', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(false);
  });

  it('handles array content blocks (OpenAI format)', () => {
    const body = {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'You are an expert coding assistant operating inside pi, hello' },
          ],
        },
      ],
    };
    const patterns = [{ pattern: 'You are an expert coding assistant operating inside pi,', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(true);
  });

  it('does not match array content blocks without matching text', () => {
    const body = {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'You are a helpful assistant.' },
          ],
        },
      ],
    };
    const patterns = [{ pattern: 'You are an expert coding assistant operating inside pi,', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(false);
  });

  it('ignores non-object blocks in array content', () => {
    const body = {
      messages: [
        {
          role: 'system',
          content: [
            null,
            { type: 'text' },
            { type: 'text', text: 'You are an expert coding assistant operating inside pi, hello' },
          ],
        },
      ],
    };
    const patterns = [{ pattern: 'You are an expert coding assistant operating inside pi,', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(true);
  });

  it('finds pattern across multiple system messages', () => {
    const body = {
      messages: [
        { role: 'system', content: 'Some other message' },
        { role: 'system', content: 'You are an expert coding assistant operating inside pi, hello' },
        { role: 'user', content: 'Hello' },
      ],
    };
    const patterns = [{ pattern: 'You are an expert coding assistant operating inside pi,', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(true);
  });

  it('handles messages with undefined content', () => {
    const body = {
      messages: [
        { role: 'system' },
        { role: 'system', content: null },
      ],
    };
    const patterns = [{ pattern: 'foo', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(false);
  });

  it('handles messages with non-string content', () => {
    const body = {
      messages: [
        { role: 'system', content: 123 },
        { role: 'system', content: { nested: true } },
      ],
    };
    const patterns = [{ pattern: 'foo', log: false }];
    const result = checkSkipPatterns(body, patterns);
    expect(result.skipped).toBe(false);
  });

  it('returns skipped:false when requestBody is not an object', () => {
    const result = checkSkipPatterns('not an object', [{ pattern: 'foo' }]);
    expect(result.skipped).toBe(false);
  });
});