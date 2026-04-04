import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formValuesFromSchemaParams,
  normalizeParamSchema,
  serializeParamsFromFormValues,
} from './param_schema.js';

test('normalizes bundle param schemas', () => {
  const schema = normalizeParamSchema({
    fields: [
      {
        key: 'edition',
        type: 'string',
        required: true,
        label: 'Edition',
        default: 'morning',
        options: [
          { value: 'morning', label: 'Morning' },
          { value: 'evening', label: 'Evening' },
        ],
      },
      {
        key: 'debug',
        type: 'boolean',
      },
      {
        key: 'overrides',
        type: 'json',
      },
    ],
  });

  assert.equal(schema.fields[0].key, 'edition');
  assert.equal(schema.fields[1].type, 'boolean');
  assert.equal(schema.fields[2].type, 'json');
});

test('maps compatible params into schema form values', () => {
  const values = formValuesFromSchemaParams(
    {
      fields: [
        { key: 'edition', type: 'string' },
        { key: 'refresh_seconds', type: 'integer' },
        { key: 'debug', type: 'boolean' },
      ],
    },
    {
      edition: 'evening',
      refresh_seconds: 15,
      debug: false,
    },
  );

  assert.deepEqual(values, {
    edition: 'evening',
    refresh_seconds: '15',
    debug: 'false',
  });
});

test('rejects params that are not declared by the bundle schema', () => {
  assert.throws(
    () => formValuesFromSchemaParams(
      {
        fields: [{ key: 'edition', type: 'string' }],
      },
      {
        edition: 'morning',
        locale: 'en-AU',
      },
    ),
    /not declared by the bundle schema/,
  );
});

test('serializes schema form values into typed params', () => {
  const params = serializeParamsFromFormValues(
    {
      fields: [
        {
          key: 'edition',
          type: 'string',
          required: true,
          options: [
            { value: 'morning', label: 'Morning' },
            { value: 'evening', label: 'Evening' },
          ],
        },
        {
          key: 'refresh_seconds',
          type: 'integer',
        },
        {
          key: 'debug',
          type: 'boolean',
        },
      ],
    },
    {
      edition: 'morning',
      refresh_seconds: '30',
      debug: 'true',
    },
  );

  assert.deepEqual(params, {
    edition: 'morning',
    refresh_seconds: 30,
    debug: true,
  });
});

test('omits blank optional schema values and enforces required ones', () => {
  assert.equal(
    serializeParamsFromFormValues(
      {
        fields: [
          { key: 'edition', type: 'string', default: 'morning' },
          { key: 'debug', type: 'boolean' },
        ],
      },
      {
        edition: '',
        debug: '',
      },
    ),
    undefined,
  );

  assert.throws(
    () => serializeParamsFromFormValues(
      {
        fields: [
          { key: 'edition', type: 'string', required: true },
        ],
      },
      {
        edition: '',
      },
    ),
    /is required/,
  );
});
