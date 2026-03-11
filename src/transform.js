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
    return false;
  }

  const updates = [];
  let totalAffectedChars = 0;

  if (typeof body.prompt === 'string') {
    const cleaned = cleanTechnicalInstructions(body.prompt);
    totalAffectedChars += cleaned.affectedChars;
    updates.push({ apply: () => { body.prompt = cleaned.text; } });
  }

  if (typeof body.input === 'string') {
    const cleaned = cleanTechnicalInstructions(body.input);
    totalAffectedChars += cleaned.affectedChars;
    updates.push({ apply: () => { body.input = cleaned.text; } });
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message) || typeof message.content !== 'string') {
        continue;
      }

      const cleaned = cleanTechnicalInstructions(message.content);
      totalAffectedChars += cleaned.affectedChars;
      updates.push({ apply: () => { message.content = cleaned.text; } });
    }
  }

  if (totalAffectedChars < minAffectedChars) {
    return false;
  }

  for (const update of updates) {
    update.apply();
  }

  return true;
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

  if (actions.deduplication === true && deduplicateRequestTextFields(next)) {
    appliedActions.push('deduplicate:text');
  }

  return {
    requestBody: next,
    appliedActions,
  };
}
