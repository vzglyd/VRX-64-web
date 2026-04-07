import { extractBundleManifest } from './bundle_manifest.js';
import { serializeParamsFromFormValues } from './param_schema.js';
import { MIN_DISPLAY_DURATION_SECONDS, MAX_DISPLAY_DURATION_SECONDS } from './constants.js';

export const PLAYLIST_FILENAME = 'playlist.json';
export const TRANSITION_OPTIONS = ['crossfade', 'wipe_left', 'wipe_down', 'dissolve', 'cut'];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalDuration(value, label) {
  if (value == null) return undefined;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_DISPLAY_DURATION_SECONDS || seconds > MAX_DISPLAY_DURATION_SECONDS) {
    throw new Error(`${label} must be an integer from ${MIN_DISPLAY_DURATION_SECONDS} to ${MAX_DISPLAY_DURATION_SECONDS}`);
  }
  return seconds;
}

function normalizeOptionalTransition(value, label) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }

  const transition = value.trim();
  if (!TRANSITION_OPTIONS.includes(transition)) {
    throw new Error(
      `${label} must be one of: ${TRANSITION_OPTIONS.join(', ')}`,
    );
  }
  return transition;
}

function normalizeOptionalEnabled(value, label) {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

export function validateBundlePath(path, label = 'playlist entry path') {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }

  const trimmed = path.trim();
  if (trimmed.startsWith('/')) {
    throw new Error(`${label} must be relative to the repo root`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(`${label} must not be an absolute URL`);
  }
  if (trimmed.includes('\\')) {
    throw new Error(`${label} must use forward slashes`);
  }
  if (trimmed.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain '.' or '..' path segments`);
  }
  if (!trimmed.endsWith('.vzglyd')) {
    throw new Error(`${label} must point to a .vzglyd bundle`);
  }

  return trimmed;
}

function normalizeDefaults(defaults) {
  if (defaults == null) {
    return {};
  }
  if (!isPlainObject(defaults)) {
    throw new Error('playlist.defaults must be an object');
  }

  const normalized = { ...defaults };
  const duration = normalizeOptionalDuration(defaults.duration_seconds, 'playlist.defaults.duration_seconds');
  const transitionIn = normalizeOptionalTransition(defaults.transition_in, 'playlist.defaults.transition_in');
  const transitionOut = normalizeOptionalTransition(defaults.transition_out, 'playlist.defaults.transition_out');

  if (duration == null) {
    delete normalized.duration_seconds;
  } else {
    normalized.duration_seconds = duration;
  }

  if (transitionIn == null) {
    delete normalized.transition_in;
  } else {
    normalized.transition_in = transitionIn;
  }

  if (transitionOut == null) {
    delete normalized.transition_out;
  } else {
    normalized.transition_out = transitionOut;
  }

  return normalized;
}

function normalizeEntry(entry, index) {
  if (!isPlainObject(entry)) {
    throw new Error(`playlist.slides[${index}] must be an object`);
  }

  const normalized = { ...entry };
  const path = validateBundlePath(entry.path, `playlist.slides[${index}].path`);
  const enabled = normalizeOptionalEnabled(entry.enabled, `playlist.slides[${index}].enabled`);
  const duration = normalizeOptionalDuration(
    entry.duration_seconds,
    `playlist.slides[${index}].duration_seconds`,
  );
  const transitionIn = normalizeOptionalTransition(
    entry.transition_in,
    `playlist.slides[${index}].transition_in`,
  );
  const transitionOut = normalizeOptionalTransition(
    entry.transition_out,
    `playlist.slides[${index}].transition_out`,
  );

  normalized.path = path;

  if (enabled == null) {
    delete normalized.enabled;
  } else {
    normalized.enabled = enabled;
  }

  if (duration == null) {
    delete normalized.duration_seconds;
  } else {
    normalized.duration_seconds = duration;
  }

  if (transitionIn == null) {
    delete normalized.transition_in;
  } else {
    normalized.transition_in = transitionIn;
  }

  if (transitionOut == null) {
    delete normalized.transition_out;
  } else {
    normalized.transition_out = transitionOut;
  }

  return normalized;
}

export function validatePlaylist(playlist) {
  if (!isPlainObject(playlist)) {
    throw new Error('playlist.json must contain a JSON object');
  }
  if (!Array.isArray(playlist.slides)) {
    throw new Error('playlist.json must contain a slides array');
  }

  return {
    ...playlist,
    defaults: normalizeDefaults(playlist.defaults),
    slides: playlist.slides.map((entry, index) => normalizeEntry(entry, index)),
  };
}

export function normalizeRepoBaseUrl(input, baseHref = 'http://localhost/') {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) {
    throw new Error('Repo base URL is required');
  }

  let url;
  try {
    url = new URL(trimmed, baseHref);
  } catch {
    throw new Error(`Invalid repo base URL: ${trimmed}`);
  }

  url.hash = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }

  return url.toString();
}

export function resolveRepoUrl(repoBaseUrl, relativePath = '', baseHref = 'http://localhost/') {
  const normalizedBase = normalizeRepoBaseUrl(repoBaseUrl, baseHref);
  if (!relativePath) {
    return normalizedBase;
  }
  return new URL(relativePath.replace(/^\.\//, ''), normalizedBase).toString();
}

async function fetchRequired(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function loadPlaylistFromRepo(
  repoBaseUrl,
  {
    fetchImpl = fetch,
    baseHref = globalThis.location?.href ?? 'http://localhost/',
  } = {},
) {
  const normalizedBase = normalizeRepoBaseUrl(repoBaseUrl, baseHref);
  const playlistUrl = resolveRepoUrl(normalizedBase, PLAYLIST_FILENAME, baseHref);
  const response = await fetchRequired(playlistUrl, fetchImpl);

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Invalid JSON in ${playlistUrl}: ${error.message}`);
  }

  return {
    repoBaseUrl: normalizedBase,
    playlistUrl,
    playlist: validatePlaylist(payload),
  };
}

export async function fetchBundleFromRepo(
  repoBaseUrl,
  bundlePath,
  {
    fetchImpl = fetch,
    baseHref = globalThis.location?.href ?? 'http://localhost/',
  } = {},
) {
  const normalizedBase = normalizeRepoBaseUrl(repoBaseUrl, baseHref);
  const validatedPath = validateBundlePath(bundlePath);
  const bundleUrl = resolveRepoUrl(normalizedBase, validatedPath, baseHref);
  const response = await fetchRequired(bundleUrl, fetchImpl);
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength === 0) {
    throw new Error(`Bundle is empty: ${bundleUrl}`);
  }

  return { bundleUrl, bytes };
}

export async function loadBundleManifestFromRepo(
  repoBaseUrl,
  bundlePath,
  options = {},
) {
  const { bundleUrl, bytes } = await fetchBundleFromRepo(repoBaseUrl, bundlePath, options);
  return {
    bundleUrl,
    manifest: extractBundleManifest(bytes, options),
  };
}

export function describePlaylistEntry(entry, defaults = {}) {
  return {
    enabled: entry.enabled !== false,
    durationSeconds: entry.duration_seconds ?? defaults.duration_seconds ?? null,
    transitionIn: entry.transition_in ?? defaults.transition_in ?? null,
    transitionOut: entry.transition_out ?? defaults.transition_out ?? null,
    hasParams: entry.params !== undefined,
  };
}

function normalizeSerializableDuration(value, label) {
  if (value == null || String(value).trim() === '') {
    return undefined;
  }
  return normalizeOptionalDuration(String(value).trim(), label);
}

function normalizeSerializableTransition(value, label) {
  if (value == null || String(value).trim() === '') {
    return undefined;
  }
  return normalizeOptionalTransition(String(value).trim(), label);
}

export function parseParamsText(paramsText, label) {
  if (paramsText == null || paramsText.trim() === '') {
    return undefined;
  }

  try {
    return JSON.parse(paramsText);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

export function toEditablePlaylist(playlist) {
  const validated = validatePlaylist(playlist);
  return {
    defaults: {
      duration_seconds: validated.defaults.duration_seconds != null
        ? String(validated.defaults.duration_seconds)
        : '',
      transition_in: validated.defaults.transition_in ?? '',
      transition_out: validated.defaults.transition_out ?? '',
    },
    slides: validated.slides.map((entry) => ({
      path: entry.path,
      enabled: entry.enabled !== false,
      duration_seconds: entry.duration_seconds != null ? String(entry.duration_seconds) : '',
      transition_in: entry.transition_in ?? '',
      transition_out: entry.transition_out ?? '',
      params_text: entry.params !== undefined ? JSON.stringify(entry.params, null, 2) : '',
      params_editor_mode: 'raw',
      params_form_values: {},
      params_schema: null,
      params_editor_message: '',
    })),
  };
}

export function emptyEditableEntry() {
  return {
    path: '',
    enabled: true,
    duration_seconds: '',
    transition_in: '',
    transition_out: '',
    params_text: '',
    params_editor_mode: 'raw',
    params_form_values: {},
    params_schema: null,
    params_editor_message: '',
  };
}

export function serializeEditablePlaylist(editablePlaylist) {
  if (!isPlainObject(editablePlaylist)) {
    throw new Error('Editable playlist state must be an object');
  }

  const defaults = {};
  const slides = Array.isArray(editablePlaylist.slides) ? editablePlaylist.slides : [];

  const defaultDuration = normalizeSerializableDuration(
    editablePlaylist.defaults?.duration_seconds,
    'defaults.duration_seconds',
  );
  const defaultTransitionIn = normalizeSerializableTransition(
    editablePlaylist.defaults?.transition_in,
    'defaults.transition_in',
  );
  const defaultTransitionOut = normalizeSerializableTransition(
    editablePlaylist.defaults?.transition_out,
    'defaults.transition_out',
  );

  if (defaultDuration != null) defaults.duration_seconds = defaultDuration;
  if (defaultTransitionIn != null) defaults.transition_in = defaultTransitionIn;
  if (defaultTransitionOut != null) defaults.transition_out = defaultTransitionOut;

  const serialized = {
    defaults,
    slides: slides.map((entry, index) => {
      const path = validateBundlePath(entry.path, `slides[${index}].path`);
      const item = { path };

      if (entry.enabled === false) {
        item.enabled = false;
      }

      const duration = normalizeSerializableDuration(
        entry.duration_seconds,
        `slides[${index}].duration_seconds`,
      );
      if (duration != null) {
        item.duration_seconds = duration;
      }

      const transitionIn = normalizeSerializableTransition(
        entry.transition_in,
        `slides[${index}].transition_in`,
      );
      if (transitionIn != null) {
        item.transition_in = transitionIn;
      }

      const transitionOut = normalizeSerializableTransition(
        entry.transition_out,
        `slides[${index}].transition_out`,
      );
      if (transitionOut != null) {
        item.transition_out = transitionOut;
      }

      const params = entry.params_schema && entry.params_editor_mode === 'schema'
        ? serializeParamsFromFormValues(
            entry.params_schema,
            entry.params_form_values,
            `slides[${index}].params`,
          )
        : parseParamsText(entry.params_text, `slides[${index}].params`);
      if (params !== undefined) {
        item.params = params;
      }

      return item;
    }),
  };

  return validatePlaylist(serialized);
}

export function stringifyPlaylist(playlist) {
  return `${JSON.stringify(validatePlaylist(playlist), null, 2)}\n`;
}
