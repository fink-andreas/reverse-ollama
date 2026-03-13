import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    categories: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          endpoints: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
          },
          match: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pathRegex: { type: 'string', minLength: 1 },
              modelRegex: { type: 'string', minLength: 1 },
              promptRegex: { type: 'string', minLength: 1 },
              messagesRegex: { type: 'string', minLength: 1 },
              rawRegex: { type: 'string', minLength: 1 },
              flags: { type: 'string' },
            },
          },
          actions: {
            type: 'object',
            additionalProperties: false,
            properties: {
              model: { type: 'string', minLength: 1 },
              num_ctx: { type: 'integer', minimum: 1 },
              deduplication: { type: 'boolean' },
              set: { type: 'object' },
              parameters: { type: 'object' },
            },
          },
        },
      },
    },
  },
  required: ['categories'],
};

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

function compileRegex(pattern, flags, categoryName, fieldName) {
  if (!pattern) {
    return null;
  }

  try {
    return new RegExp(pattern, flags || '');
  } catch (error) {
    throw new Error(`Invalid ${fieldName} in category '${categoryName}': ${error.message}`);
  }
}

export function normalizeConfig(config) {
  return {
    categories: config.categories.map((category) => {
      const flags = category.match?.flags || '';
      const compiledMatchers = {
        pathRegex: compileRegex(category.match?.pathRegex, flags, category.name, 'pathRegex'),
        modelRegex: compileRegex(category.match?.modelRegex, flags, category.name, 'modelRegex'),
        promptRegex: compileRegex(category.match?.promptRegex, flags, category.name, 'promptRegex'),
        messagesRegex: compileRegex(category.match?.messagesRegex, flags, category.name, 'messagesRegex'),
        rawRegex: compileRegex(category.match?.rawRegex, flags, category.name, 'rawRegex'),
      };

      return {
        ...category,
        endpoints: category.endpoints || [],
        match: category.match || {},
        actions: category.actions || {},
        compiledMatchers,
      };
    }),
  };
}

export function getConfigPath() {
  return (
    process.env.REVERSE_OLLAMA_CONFIG ||
    process.env.REVERSELLAMA_CONFIG ||
    path.join(projectRoot, 'config', 'categories.json')
  );
}

export function validateConfig(config, configPath = 'config') {
  const valid = validate(config);
  if (!valid) {
    const details = ajv.errorsText(validate.errors, { separator: '; ' });
    throw new Error(`Invalid config at ${configPath}: ${details}`);
  }
}

export async function loadConfig() {
  const configPath = getConfigPath();
  const raw = await readFile(configPath, 'utf8');
  const config = JSON.parse(raw);

  validateConfig(config, configPath);
  const normalizedConfig = normalizeConfig(config);

  return { config: normalizedConfig, configPath };
}
