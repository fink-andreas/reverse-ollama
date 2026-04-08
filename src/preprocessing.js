/**
 * Preprocessing module for message content replacement.
 *
 * Checks if user message content matches configured regex patterns,
 * and if all lines match all patterns, replaces the content while preserving JSON blocks.
 */

/**
 * Extract JSON blocks from text, preserving their positions.
 * Returns an array of segments with isJson flag.
 *
 * @param {string} text - The text to parse
 * @returns {Array<{text: string, isJson: boolean}>} - Segments with JSON flag
 */
export function extractSegments(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }

  // Normalize line endings: convert \r\n to \n, strip standalone \r
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
  const lines = normalized.split('\n');
  const segments = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect JSON lines (objects or arrays)
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');

    segments.push({
      text: line,
      isJson,
    });
  }

  return segments;
}

/**
 * Check if a single line matches all of the compiled patterns.
 *
 * @param {string} line - The line to check
 * @param {RegExp[]} patterns - Compiled regex patterns
 * @returns {boolean} - True if line matches all patterns
 */
function lineMatchesAllPatterns(line, patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const trimmed = line.trim();

  // Empty lines always match (they're not content)
  if (trimmed.length === 0) {
    return true;
  }

  for (const pattern of patterns) {
    // Reset lastIndex for global/sticky regexes
    pattern.lastIndex = 0;
    if (!pattern.test(line)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if all patterns have at least one matching line in the text.
 * Each pattern must match at least one non-JSON line (all patterns must be satisfied).
 *
 * @param {string} text - The text to check
 * @param {RegExp[]} patterns - Compiled regex patterns
 * @returns {boolean} - True if all patterns match at least one line
 */
export function allNonJsonLinesMatch(text, patterns) {
  const segments = extractSegments(text);

  if (segments.length === 0) {
    return false;
  }

  // If there are no patterns, never match
  if (!patterns || patterns.length === 0) {
    return false;
  }

  // Track which patterns have been matched
  const matchedPatterns = new Set();

  for (const segment of segments) {
    // Skip JSON segments - they don't count for matching
    if (segment.isJson) {
      continue;
    }

    // Check if this line matches any unmatched pattern
    for (let i = 0; i < patterns.length; i++) {
      if (matchedPatterns.has(i)) {
        continue; // Already matched this pattern
      }
      const pattern = patterns[i];
      pattern.lastIndex = 0;
      if (pattern.test(segment.text)) {
        matchedPatterns.add(i);
      }
    }

    // Early exit if all patterns have been matched
    if (matchedPatterns.size === patterns.length) {
      return true;
    }
  }

  // All patterns must be matched
  return matchedPatterns.size === patterns.length;
}

/**
 * Extract JSON blocks from text.
 *
 * @param {string} text - The text to extract from
 * @returns {string[]} - Array of JSON block strings
 */
export function extractJsonBlocks(text) {
  const segments = extractSegments(text);
  const jsonBlocks = [];

  for (const segment of segments) {
    if (segment.isJson) {
      jsonBlocks.push(segment.text);
    }
  }

  return jsonBlocks;
}

/**
 * Apply preprocessing to a request body.
 *
 * @param {object} requestBody - The request body to process
 * @param {object} preprocessingConfig - The preprocessing configuration
 * @returns {{requestBody: object, appliedRules: string[]}} - Processed body and applied rule IDs
 */
export function applyPreprocessing(requestBody, preprocessingConfig) {
  if (!requestBody || typeof requestBody !== 'object') {
    return { requestBody, appliedRules: [] };
  }

  if (!preprocessingConfig || !Array.isArray(preprocessingConfig.promptReplaces)) {
    return { requestBody, appliedRules: [] };
  }

  const rules = preprocessingConfig.promptReplaces;
  const appliedRules = [];

  // Clone the body to avoid mutating the original
  const result = JSON.parse(JSON.stringify(requestBody));

  // Process messages array if present
  if (Array.isArray(result.messages)) {
    for (const message of result.messages) {
      if (!message || message.role !== 'user' || typeof message.content !== 'string') {
        continue;
      }

      for (const rule of rules) {
        if (!rule.compiledPatterns || !Array.isArray(rule.replace)) {
          continue;
        }

        // Check if all non-JSON lines match the patterns
        if (allNonJsonLinesMatch(message.content, rule.compiledPatterns)) {
          // Extract JSON blocks to preserve
          const jsonBlocks = extractJsonBlocks(message.content);

          // Build replacement content
          const replacementParts = [...rule.replace];

          // Append preserved JSON blocks
          if (jsonBlocks.length > 0) {
            replacementParts.push(...jsonBlocks);
          }

          // Replace the message content
          message.content = replacementParts.join('\n');
          appliedRules.push(rule.id || 'unknown');

          // Only apply the first matching rule per message
          break;
        }
      }
    }
  }

  // Process prompt field if present (for /api/generate endpoint)
  if (typeof result.prompt === 'string') {
    for (const rule of rules) {
      if (!rule.compiledPatterns || !Array.isArray(rule.replace)) {
        continue;
      }

      if (allNonJsonLinesMatch(result.prompt, rule.compiledPatterns)) {
        const jsonBlocks = extractJsonBlocks(result.prompt);
        const replacementParts = [...rule.replace];

        if (jsonBlocks.length > 0) {
          replacementParts.push(...jsonBlocks);
        }

        result.prompt = replacementParts.join('\n');
        appliedRules.push(rule.id || 'unknown');
        break;
      }
    }
  }

  // Process input field if present (for some endpoints)
  if (typeof result.input === 'string') {
    for (const rule of rules) {
      if (!rule.compiledPatterns || !Array.isArray(rule.replace)) {
        continue;
      }

      if (allNonJsonLinesMatch(result.input, rule.compiledPatterns)) {
        const jsonBlocks = extractJsonBlocks(result.input);
        const replacementParts = [...rule.replace];

        if (jsonBlocks.length > 0) {
          replacementParts.push(...jsonBlocks);
        }

        result.input = replacementParts.join('\n');
        appliedRules.push(rule.id || 'unknown');
        break;
      }
    }
  }

  return { requestBody: result, appliedRules };
}
