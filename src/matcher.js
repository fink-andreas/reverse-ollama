function buildMatchText(body) {
  if (!body || typeof body !== 'object') {
    return {
      model: '',
      prompt: '',
      messages: '',
    };
  }

  const model = typeof body.model === 'string' ? body.model : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const messages = Array.isArray(body.messages)
    ? body.messages
        .map((entry) => (entry && typeof entry.content === 'string' ? entry.content : ''))
        .filter(Boolean)
        .join('\n')
    : '';

  return { model, prompt, messages };
}

function endpointMatches(category, requestPath) {
  if (!category.endpoints || category.endpoints.length === 0) {
    return true;
  }

  return category.endpoints.includes(requestPath);
}

export function categoryMatches({ category, requestPath, requestBody, rawBodyText }) {
  if (!endpointMatches(category, requestPath)) {
    return false;
  }

  const compiled = category.compiledMatchers || {};
  const hasRegexRule = Object.values(compiled).some(Boolean);

  if (!hasRegexRule) {
    return true;
  }

  const values = buildMatchText(requestBody);

  if (compiled.pathRegex && !compiled.pathRegex.test(requestPath)) {
    return false;
  }
  if (compiled.modelRegex && !compiled.modelRegex.test(values.model)) {
    return false;
  }
  if (compiled.promptRegex && !compiled.promptRegex.test(values.prompt)) {
    return false;
  }
  if (compiled.messagesRegex && !compiled.messagesRegex.test(values.messages)) {
    return false;
  }
  if (compiled.rawRegex && !compiled.rawRegex.test(rawBodyText || '')) {
    return false;
  }

  return true;
}

export function matchRequestCategory({ categories, requestPath, requestBody, rawBodyText }) {
  for (const category of categories || []) {
    if (categoryMatches({ category, requestPath, requestBody, rawBodyText })) {
      return category;
    }
  }

  return null;
}
