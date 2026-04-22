/**
 * Session skip detection module.
 *
 * Checks if a request matches any of the configured `sessionLogSkip` patterns.
 * All patterns must match at least one system message for the request to be skipped.
 *
 * Matching logic:
 * - Looks for `messages[].role === 'system'` with `content` (string or array)
 * - For string content: uses `startsWith` against each pattern
 * - For array content (content blocks): checks each block's `text` field
 * - All patterns must match at least one system message to skip
 */

/**
 * Check a single content value (string) against a pattern.
 * @param {*} content - The content value to check
 * @param {string} pattern - The pattern to match (uses startsWith)
 * @returns {boolean}
 */
function contentMatches(content, pattern) {
  if (typeof content === 'string') {
    return content.startsWith(pattern);
  }
  return false;
}

/**
 * Check if a system message matches a pattern.
 * Content can be a string or an array of content blocks.
 * @param {object} message - The message object
 * @param {string} pattern - The pattern to match
 * @returns {boolean}
 */
function messageMatchesPattern(message, pattern) {
  if (message.role !== 'system') {
    return false;
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content.startsWith(pattern);
  }

  if (Array.isArray(content)) {
    // Content blocks: check each block's `text` field
    return content.some((block) => {
      if (typeof block === 'object' && block !== null && typeof block.text === 'string') {
        return block.text.startsWith(pattern);
      }
      return false;
    });
  }

  return false;
}

/**
 * Check if the request body matches the session skip patterns.
 * @param {object|null} requestBody - Parsed request body
 * @param {Array} patterns - Compiled array of {pattern, log} objects
 * @returns {{ skipped: boolean, logSkipped: boolean }}
 */
export function checkSkipPatterns(requestBody, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { skipped: false, logSkipped: false };
  }

  if (!requestBody || typeof requestBody !== 'object') {
    return { skipped: false, logSkipped: false };
  }

  const messages = requestBody.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { skipped: false, logSkipped: false };
  }

  let allPatternsMatched = true;
  let shouldLog = false;

  for (const { pattern, log } of patterns) {
    const matched = messages.some((msg) => messageMatchesPattern(msg, pattern));
    if (!matched) {
      allPatternsMatched = false;
      break;
    }
    if (log === true) {
      shouldLog = true;
    }
  }

  return {
    skipped: allPatternsMatched,
    logSkipped: shouldLog,
  };
}