import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneBody(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function shallowMerge(target, source) {
  if (!isObject(source)) {
    return target;
  }

  return {
    ...(isObject(target) ? target : {}),
    ...source,
  };
}

const DEDUPLICATION_MIN_AFFECTED_CHARS = 60;

let deduplicationConfig = null;
let deduplicationConfigLoadPromise = null;

function getDeduplicationConfigPath() {
  return process.env.DEDUPLICATION_CONFIG || path.join(projectRoot, 'config', 'deduplication.json');
}

async function loadDeduplicationConfig() {
  const configPath = getDeduplicationConfigPath();
  try {
    const raw = await readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    return config || { prefixPatterns: [] };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { prefixPatterns: [] };
    }
    throw error;
  }
}

export async function ensureDeduplicationConfigLoaded() {
  if (deduplicationConfig) {
    return deduplicationConfig;
  }

  if (deduplicationConfigLoadPromise) {
    return deduplicationConfigLoadPromise;
  }

  deduplicationConfigLoadPromise = loadDeduplicationConfig();
  deduplicationConfig = await deduplicationConfigLoadPromise;
  deduplicationConfigLoadPromise = null;
  return deduplicationConfig;
}

export function resetDeduplicationConfig() {
  deduplicationConfig = null;
  deduplicationConfigLoadPromise = null;
}

function removeDuplicatePrefixPatterns(text, prefixPatterns) {
  if (typeof text !== 'string' || text.length === 0 || !Array.isArray(prefixPatterns) || prefixPatterns.length === 0) {
    return { text, affectedChars: 0, patternsRemoved: [] };
  }

  let result = text;
  let affectedChars = 0;
  const patternsRemoved = [];

  for (const patternConfig of prefixPatterns) {
    const pattern = patternConfig?.pattern;
    if (typeof pattern !== 'string' || pattern.length === 0) {
      continue;
    }

    // Count occurrences using split
    const parts = result.split(pattern);
    
    if (parts.length <= 1) {
      // Pattern not found
      continue;
    }

    // Keep first occurrence by joining with the pattern only once
    // parts[0] is before first occurrence, parts[1] is between 1st and 2nd, etc.
    // We want: parts[0] + pattern + parts[1] + parts[2] + ... (no pattern between subsequent parts)
    const occurrences = parts.length - 1;
    
    if (occurrences > 1) {
      // Calculate affected chars: each removed pattern
      affectedChars += pattern.length * (occurrences - 1);
      patternsRemoved.push(patternConfig.id || 'unknown');
      
      // Rebuild with only first occurrence
      result = parts[0] + pattern + parts.slice(1).join('');
    }
  }

  return { text: result, affectedChars, patternsRemoved };
}

function cleanTechnicalInstructions(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, affectedChars: 0 };
  }

  const normalizedText = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n');

  const lines = normalizedText.split('\n');
  const seen = new Set();
  const result = [];
  let affectedChars = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      result.push(line);
      continue;
    }

    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(line);
      continue;
    }

    if (trimmed.length > 0) {
      affectedChars += line.length + 1;
    }
  }

  return {
    text: result.join('\n'),
    affectedChars,
  };
}

function deduplicateRequestTextFields(body, minAffectedChars = DEDUPLICATION_MIN_AFFECTED_CHARS) {
  if (!isObject(body)) {
    return { modified: false, patternsRemoved: [] };
  }

  const updates = [];
  let totalAffectedChars = 0;
  const allPatternsRemoved = [];

  // Get prefix patterns from loaded config
  const prefixPatterns = deduplicationConfig?.prefixPatterns || [];

  const processTextField = (text) => {
    let result = text;
    let affected = 0;
    const removed = [];

    // First apply prefix pattern deduplication
    if (prefixPatterns.length > 0) {
      const prefixResult = removeDuplicatePrefixPatterns(result, prefixPatterns);
      result = prefixResult.text;
      affected += prefixResult.affectedChars;
      removed.push(...prefixResult.patternsRemoved);
    }

    // Then apply line deduplication
    const cleaned = cleanTechnicalInstructions(result);
    result = cleaned.text;
    affected += cleaned.affectedChars;

    return { text: result, affectedChars: affected, patternsRemoved: removed };
  };

  if (typeof body.prompt === 'string') {
    const result = processTextField(body.prompt);
    totalAffectedChars += result.affectedChars;
    allPatternsRemoved.push(...result.patternsRemoved);
    updates.push({ apply: () => { body.prompt = result.text; } });
  }

  if (typeof body.input === 'string') {
    const result = processTextField(body.input);
    totalAffectedChars += result.affectedChars;
    allPatternsRemoved.push(...result.patternsRemoved);
    updates.push({ apply: () => { body.input = result.text; } });
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message) || typeof message.content !== 'string') {
        continue;
      }

      const result = processTextField(message.content);
      totalAffectedChars += result.affectedChars;
      allPatternsRemoved.push(...result.patternsRemoved);
      updates.push({ apply: () => { message.content = result.text; } });
    }
  }

  if (totalAffectedChars < minAffectedChars && allPatternsRemoved.length === 0) {
    return { modified: false, patternsRemoved: [] };
  }

  for (const update of updates) {
    update.apply();
  }

  return { modified: true, patternsRemoved: [...new Set(allPatternsRemoved)] };
}

export function applyActions({ requestBody, category }) {
  const actions = category?.actions || {};
  if (!isObject(requestBody) || Object.keys(actions).length === 0) {
    return {
      requestBody,
      appliedActions: [],
    };
  }

  const next = cloneBody(requestBody);
  const appliedActions = [];

  if (typeof actions.model === 'string' && actions.model.length > 0) {
    next.model = actions.model;
    appliedActions.push('replace:model');
  }

  if (Number.isInteger(actions.num_ctx) && actions.num_ctx > 0) {
    next.options = shallowMerge(next.options, { num_ctx: actions.num_ctx });
    appliedActions.push('set:options.num_ctx');
  }

  if (isObject(actions.set)) {
    Object.assign(next, actions.set);
    appliedActions.push('merge:set');
  }

  if (actions.deduplication === true) {
    const dedupResult = deduplicateRequestTextFields(next);
    if (dedupResult.modified) {
      appliedActions.push('deduplicate:text');
      if (dedupResult.patternsRemoved.length > 0) {
        appliedActions.push(`deduplicate:prefix:${dedupResult.patternsRemoved.join(',')}`);
      }
    }
  }

  return {
    requestBody: next,
    appliedActions,
  };
}
