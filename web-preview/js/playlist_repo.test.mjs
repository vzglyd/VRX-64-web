import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describePlaylistEntry,
  fetchBundleFromRepo,
  loadBundleManifestFromRepo,
  loadPlaylistFromRepo,
  normalizeRepoBaseUrl,
  serializeEditablePlaylist,
  stringifyPlaylist,
  validatePlaylist,
} from './playlist_repo.js';

test('normalizes repo URLs to a trailing slash', () => {
  assert.equal(
    normalizeRepoBaseUrl('http://localhost:8081/shared'),
    'http://localhost:8081/shared/',
  );
});

test('normalizes GitHub Pages roots to a trailing slash', () => {
  assert.equal(
    normalizeRepoBaseUrl('https://rodgerbenham.github.io/vzglyd'),
    'https://rodgerbenham.github.io/vzglyd/',
  );
});

test('rejects playlist entries that are not .vzglyd bundles', () => {
  assert.throws(
    () => validatePlaylist({ slides: [{ path: 'clock/slide.wasm' }] }),
    /must point to a \.vzglyd bundle/,
  );
});

test('loads and validates playlist.json from a repo base URL', async () => {
  const result = await loadPlaylistFromRepo('https://slides.example.test/showcase', {
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({
        defaults: { duration_seconds: 10, transition_in: 'crossfade' },
        slides: [{ path: 'clock.vzglyd', transition_out: 'cut' }],
      }),
    }),
  });

  assert.equal(result.repoBaseUrl, 'https://slides.example.test/showcase/');
  assert.equal(result.playlistUrl, 'https://slides.example.test/showcase/playlist.json');
  assert.equal(result.playlist.slides[0].path, 'clock.vzglyd');
});

test('fetches bundle bytes relative to the repo root', async () => {
  const result = await fetchBundleFromRepo('https://slides.example.test/showcase/', 'daily/clock.vzglyd', {
    fetchImpl: async (url) => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }),
  });

  assert.equal(result.bundleUrl, 'https://slides.example.test/showcase/daily/clock.vzglyd');
  assert.deepEqual(Array.from(result.bytes), [1, 2, 3]);
});

test('loads bundle manifest metadata relative to the repo root', async () => {
  const result = await loadBundleManifestFromRepo(
    'https://rodgerbenham.github.io/vzglyd',
    'daily/headlines.vzglyd',
    {
      fetchImpl: async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
      unzipSyncImpl: () => ({
        'manifest.json': new TextEncoder().encode(JSON.stringify({
          name: 'Headlines',
          description: 'Morning edition',
          display: { duration_seconds: 12 },
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
        })),
        'slide.wasm': new Uint8Array([0, 97, 115, 109]),
      }),
    },
  );

  assert.equal(result.bundleUrl, 'https://rodgerbenham.github.io/vzglyd/daily/headlines.vzglyd');
  assert.equal(result.manifest.name, 'Headlines');
  assert.equal(result.manifest.params.fields[0].key, 'edition');
});

test('serializes editable playlists into canonical playlist.json shape', () => {
  const playlist = serializeEditablePlaylist({
    defaults: {
      duration_seconds: '15',
      transition_in: 'crossfade',
      transition_out: '',
    },
    slides: [
      {
        path: 'clock.vzglyd',
        enabled: true,
        duration_seconds: '',
        transition_in: '',
        transition_out: 'cut',
        params_text: '{ "mode": "demo" }',
      },
      {
        path: 'weather.vzglyd',
        enabled: false,
        duration_seconds: '20',
        transition_in: 'wipe_left',
        transition_out: '',
        params_text: '',
      },
    ],
  });

  assert.equal(
    stringifyPlaylist(playlist),
    `{
  "defaults": {
    "duration_seconds": 15,
    "transition_in": "crossfade"
  },
  "slides": [
    {
      "path": "clock.vzglyd",
      "transition_out": "cut",
      "params": {
        "mode": "demo"
      }
    },
    {
      "path": "weather.vzglyd",
      "enabled": false,
      "duration_seconds": 20,
      "transition_in": "wipe_left"
    }
  ]
}
`,
  );
});

test('serializes schema-driven params without forcing bundle defaults into playlist.json', () => {
  const playlist = serializeEditablePlaylist({
    defaults: {},
    slides: [
      {
        path: 'daily/headlines.vzglyd',
        enabled: true,
        duration_seconds: '',
        transition_in: '',
        transition_out: '',
        params_text: '',
        params_editor_mode: 'schema',
        params_form_values: {
          edition: 'evening',
          refresh_seconds: '',
          debug: 'false',
        },
        params_schema: {
          fields: [
            {
              key: 'edition',
              type: 'string',
              required: true,
              default: 'morning',
              options: [
                { value: 'morning', label: 'Morning' },
                { value: 'evening', label: 'Evening' },
              ],
            },
            {
              key: 'refresh_seconds',
              type: 'integer',
              default: 30,
            },
            {
              key: 'debug',
              type: 'boolean',
            },
          ],
        },
      },
    ],
  });

  assert.deepEqual(playlist, {
    defaults: {},
    slides: [
      {
        path: 'daily/headlines.vzglyd',
        params: {
          edition: 'evening',
          debug: false,
        },
      },
    ],
  });
});

test('preserves reordered editable slides in serialized output order', () => {
  const playlist = serializeEditablePlaylist({
    defaults: {},
    slides: [
      {
        path: 'weather.vzglyd',
        enabled: true,
        duration_seconds: '',
        transition_in: '',
        transition_out: '',
        params_text: '',
      },
      {
        path: 'clock.vzglyd',
        enabled: true,
        duration_seconds: '',
        transition_in: '',
        transition_out: '',
        params_text: '',
      },
    ],
  });

  assert.deepEqual(
    playlist.slides.map((entry) => entry.path),
    ['weather.vzglyd', 'clock.vzglyd'],
  );
});

test('describes effective entry metadata using playlist defaults', () => {
  const description = describePlaylistEntry(
    { path: 'clock.vzglyd', transition_out: 'cut' },
    { duration_seconds: 9, transition_in: 'crossfade' },
  );

  assert.deepEqual(description, {
    enabled: true,
    durationSeconds: 9,
    transitionIn: 'crossfade',
    transitionOut: 'cut',
    hasParams: false,
  });
});
