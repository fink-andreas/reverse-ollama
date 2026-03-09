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

  return {
    requestBody: next,
    appliedActions,
  };
}
