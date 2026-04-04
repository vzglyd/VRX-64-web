import test from 'node:test';
import assert from 'node:assert/strict';

import { extractBundleManifest, unpackBundle } from './bundle_manifest.js';

function archive(entries) {
  return () => Object.fromEntries(
    Object.entries(entries).map(([path, value]) => [
      path,
      value instanceof Uint8Array ? value : new TextEncoder().encode(value),
    ]),
  );
}

test('extracts and normalizes manifest metadata from a bundle archive', () => {
  const manifest = extractBundleManifest(new Uint8Array([1, 2, 3]), {
    unzipSyncImpl: archive({
      'manifest.json': JSON.stringify({
        name: 'Headlines',
        display: { duration_seconds: '12', transition_in: 'crossfade' },
        params: {
          fields: [
            {
              key: 'edition',
              type: 'string',
              default: 'morning',
              options: [
                { value: 'morning', label: 'Morning' },
                { value: 'evening', label: 'Evening' },
              ],
            },
          ],
        },
      }),
      'slide.wasm': new Uint8Array([0, 97, 115, 109]),
    }),
  });

  assert.equal(manifest.name, 'Headlines');
  assert.equal(manifest.display.duration_seconds, 12);
  assert.equal(manifest.params.fields[0].key, 'edition');
});

test('unpackBundle keeps non-manifest assets available for runtime use', () => {
  const bundle = unpackBundle(new Uint8Array([1, 2, 3]), {
    unzipSyncImpl: archive({
      'manifest.json': JSON.stringify({ name: 'Clock' }),
      'slide.wasm': new Uint8Array([0, 97, 115, 109]),
      'assets/logo.png': new Uint8Array([137, 80, 78, 71]),
    }),
  });

  assert.equal(bundle.manifest.name, 'Clock');
  assert.deepEqual(Array.from(bundle.miscAssets.get('assets/logo.png')), [137, 80, 78, 71]);
  assert.deepEqual(Array.from(bundle.miscAssets.get('logo.png')), [137, 80, 78, 71]);
});

test('rejects invalid advertised param schemas', () => {
  assert.throws(
    () => extractBundleManifest(new Uint8Array([1, 2, 3]), {
      unzipSyncImpl: archive({
        'manifest.json': JSON.stringify({
          params: {
            fields: [
              { key: 'payload', type: 'json', options: [{ value: { mode: 'demo' } }] },
            ],
          },
        }),
        'slide.wasm': new Uint8Array([0, 97, 115, 109]),
      }),
    }),
    /not supported for json fields/,
  );
});
