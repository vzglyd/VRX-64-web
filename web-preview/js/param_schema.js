export const PARAM_FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'json'];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function jsonValueKey(value) {
  return JSON.stringify(value);
}

function assertJsonSerializable(value, label) {
  try {
    return cloneJsonValue(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable: ${error.message}`);
  }
}

function normalizeFieldLabel(value, label) {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function validateTypedValue(value, type, label) {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new Error(`${label} must be a string`);
      }
      break;
    case 'integer':
      if (!Number.isInteger(value)) {
        throw new Error(`${label} must be an integer`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(`${label} must be a boolean`);
      }
      break;
    case 'json':
      assertJsonSerializable(value, label);
      break;
    default:
      throw new Error(`${label} has unsupported type '${type}'`);
  }

  return cloneJsonValue(value);
}

function normalizeFieldOptions(type, options, label) {
  if (options == null) {
    return [];
  }
  if (!Array.isArray(options)) {
    throw new Error(`${label} must be an array`);
  }
  if (type === 'json' && options.length > 0) {
    throw new Error(`${label} is not supported for json fields`);
  }

  const seen = new Set();
  return options.map((option, index) => {
    if (!isPlainObject(option)) {
      throw new Error(`${label}[${index}] must be an object`);
    }

    const value = validateTypedValue(
      option.value,
      type,
      `${label}[${index}].value`,
    );
    const optionKey = jsonValueKey(value);
    if (seen.has(optionKey)) {
      throw new Error(`${label} contains duplicate values`);
    }
    seen.add(optionKey);

    return {
      value,
      label: normalizeFieldLabel(option.label, `${label}[${index}].label`),
    };
  });
}

export function normalizeParamSchema(schema, label = 'manifest.params') {
  if (!isPlainObject(schema)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(schema.fields)) {
    throw new Error(`${label}.fields must be an array`);
  }

  const seenKeys = new Set();
  return {
    fields: schema.fields.map((field, index) => {
      if (!isPlainObject(field)) {
        throw new Error(`${label}.fields[${index}] must be an object`);
      }

      if (typeof field.key !== 'string' || field.key.trim() === '') {
        throw new Error(`${label}.fields[${index}].key must be a non-empty string`);
      }
      const key = field.key.trim();
      if (seenKeys.has(key)) {
        throw new Error(`${label}.fields contains duplicate key '${key}'`);
      }
      seenKeys.add(key);

      if (!PARAM_FIELD_TYPES.includes(field.type)) {
        throw new Error(
          `${label}.fields[${index}].type must be one of: ${PARAM_FIELD_TYPES.join(', ')}`,
        );
      }

      const type = field.type;
      const options = normalizeFieldOptions(type, field.options, `${label}.fields[${index}].options`);
      const defaultValue = field.default === undefined
        ? undefined
        : validateTypedValue(field.default, type, `${label}.fields[${index}].default`);

      if (defaultValue !== undefined && options.length > 0) {
        const defaultKey = jsonValueKey(defaultValue);
        if (!options.some((option) => jsonValueKey(option.value) === defaultKey)) {
          throw new Error(`${label}.fields[${index}].default must match one of the declared options`);
        }
      }

      return {
        key,
        type,
        required: field.required === true,
        label: normalizeFieldLabel(field.label, `${label}.fields[${index}].label`),
        help: normalizeFieldLabel(field.help, `${label}.fields[${index}].help`),
        default: defaultValue,
        options,
      };
    }),
  };
}

function encodeFormValue(field, value, label) {
  const normalized = validateTypedValue(value, field.type, label);
  switch (field.type) {
    case 'string':
      return normalized;
    case 'integer':
    case 'number':
      return String(normalized);
    case 'boolean':
      return normalized ? 'true' : 'false';
    case 'json':
      return JSON.stringify(normalized, null, 2);
    default:
      return '';
  }
}

function parseNumericInput(rawValue, label, integerOnly) {
  const text = String(rawValue);
  if (text === '') {
    return undefined;
  }

  const value = Number(text);
  if (!Number.isFinite(value) || (integerOnly && !Number.isInteger(value))) {
    throw new Error(`${label} must be a${integerOnly ? 'n integer' : ' number'}`);
  }
  return value;
}

function parseJsonInput(rawValue, label) {
  if (rawValue === '') {
    return undefined;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function parseFieldInput(field, rawValue, label) {
  switch (field.type) {
    case 'string':
      return rawValue === '' ? undefined : String(rawValue);
    case 'integer':
      return parseNumericInput(rawValue, label, true);
    case 'number':
      return parseNumericInput(rawValue, label, false);
    case 'boolean':
      if (rawValue === '') {
        return undefined;
      }
      if (rawValue === true || rawValue === false) {
        return rawValue;
      }
      if (rawValue === 'true') {
        return true;
      }
      if (rawValue === 'false') {
        return false;
      }
      throw new Error(`${label} must be true or false`);
    case 'json':
      return parseJsonInput(String(rawValue), label);
    default:
      throw new Error(`${label} has unsupported type '${field.type}'`);
  }
}

export function formValuesFromSchemaParams(schema, params, label = 'params') {
  const normalizedSchema = normalizeParamSchema(schema);
  if (params === undefined) {
    return Object.fromEntries(normalizedSchema.fields.map((field) => [field.key, '']));
  }
  if (!isPlainObject(params)) {
    throw new Error(`${label} must be an object to use schema-driven editing`);
  }

  const fieldMap = new Map(normalizedSchema.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(params)) {
    if (!fieldMap.has(key)) {
      throw new Error(`${label}.${key} is not declared by the bundle schema`);
    }
  }

  const values = {};
  for (const field of normalizedSchema.fields) {
    if (!(field.key in params)) {
      values[field.key] = '';
      continue;
    }
    values[field.key] = encodeFormValue(field, params[field.key], `${label}.${field.key}`);
  }

  return values;
}

export function serializeParamsFromFormValues(
  schema,
  formValues,
  label = 'params',
) {
  const normalizedSchema = normalizeParamSchema(schema);
  const serialized = {};

  for (const field of normalizedSchema.fields) {
    const rawValue = isPlainObject(formValues) && field.key in formValues
      ? formValues[field.key]
      : '';
    const value = parseFieldInput(field, rawValue, `${label}.${field.key}`);

    if (value === undefined) {
      if (field.required && field.default === undefined) {
        throw new Error(`${label}.${field.key} is required`);
      }
      continue;
    }

    validateTypedValue(value, field.type, `${label}.${field.key}`);

    if (field.options.length > 0) {
      const serializedValue = jsonValueKey(value);
      if (!field.options.some((option) => jsonValueKey(option.value) === serializedValue)) {
        throw new Error(`${label}.${field.key} must match one of the declared options`);
      }
    }

    serialized[field.key] = cloneJsonValue(value);
  }

  return Object.keys(serialized).length > 0 ? serialized : undefined;
}

export function describeParamField(field) {
  const defaultText = field.default === undefined
    ? ''
    : (typeof field.default === 'string'
      ? field.default
      : JSON.stringify(field.default));
  return {
    label: field.label ?? field.key,
    help: field.help ?? '',
    defaultText,
  };
}
