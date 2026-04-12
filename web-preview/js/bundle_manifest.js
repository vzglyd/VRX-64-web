import { normalizeParamSchema } from './param_schema.js';
import { MIN_DISPLAY_DURATION_SECONDS, MAX_DISPLAY_DURATION_SECONDS } from './constants.js';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function asUint8Array(bytesLike) {
  if (bytesLike instanceof Uint8Array) return bytesLike;
  if (ArrayBuffer.isView(bytesLike)) {
    return new Uint8Array(bytesLike.buffer, bytesLike.byteOffset, bytesLike.byteLength);
  }
  if (bytesLike instanceof ArrayBuffer) {
    return new Uint8Array(bytesLike);
  }
  throw new Error('expected Uint8Array-compatible bundle bytes');
}

function getUnzipSync(unzipSyncImpl = null) {
  if (typeof unzipSyncImpl === 'function') {
    return unzipSyncImpl;
  }

  const api = globalThis.fflate;
  if (!api || typeof api.unzipSync !== 'function') {
    throw new Error('fflate unzipSync API unavailable; include fflate before loading the bundle tools');
  }
  return api.unzipSync.bind(api);
}

function archiveEntries(bundleBytes, unzipSyncImpl = null) {
  const unzipSync = getUnzipSync(unzipSyncImpl);
  return Object.entries(unzipSync(asUint8Array(bundleBytes))).map(([path, bytes]) => ({
    path,
    base: path.split('/').filter(Boolean).pop() ?? path,
    bytes,
  }));
}

function pickEntry(entries, preferredBaseNames) {
  for (const baseName of preferredBaseNames) {
    const exact = entries.find((entry) => entry.base === baseName);
    if (exact) return exact;
  }
  return null;
}

function parseManifest(manifestBytes) {
  const manifestJson = new TextDecoder().decode(manifestBytes);
  return JSON.parse(manifestJson);
}

function normalizePackagePath(path, label) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  const trimmed = path.trim();
  if (trimmed.startsWith('/')) {
    throw new Error(`${label} must be relative to the package root`);
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
  return trimmed;
}

function normalizeArtRef(ref, label) {
  if (!isPlainObject(ref)) {
    throw new Error(`${label} must be an object`);
  }
  const normalized = { ...ref, path: normalizePackagePath(ref.path, `${label}.path`) };
  if (ref.label != null) {
    if (typeof ref.label !== 'string' || ref.label.trim() === '') {
      throw new Error(`${label}.label must be a non-empty string`);
    }
    normalized.label = ref.label.trim();
  }
  return normalized;
}

function normalizeCassetteArt(art, label) {
  if (!isPlainObject(art)) {
    throw new Error(`${label} is required`);
  }
  return {
    ...art,
    j_card: normalizeArtRef(art.j_card, `${label}.j_card`),
    side_a_label: normalizeArtRef(art.side_a_label, `${label}.side_a_label`),
    side_b_label: normalizeArtRef(art.side_b_label, `${label}.side_b_label`),
  };
}

function normalizeAssetsConfig(assets, label) {
  if (!isPlainObject(assets)) {
    throw new Error(`${label}.art is required`);
  }
  return {
    ...assets,
    art: normalizeCassetteArt(assets.art, `${label}.art`),
  };
}

function normalizeDisplayConfig(display, label) {
  if (display == null) {
    return undefined;
  }
  if (!isPlainObject(display)) {
    throw new Error(`${label} must be an object`);
  }

  const normalized = { ...display };
  if (display.duration_seconds != null) {
    const seconds = Number(display.duration_seconds);
    if (!Number.isInteger(seconds) || seconds < MIN_DISPLAY_DURATION_SECONDS || seconds > MAX_DISPLAY_DURATION_SECONDS) {
      throw new Error(`${label}.duration_seconds must be in [${MIN_DISPLAY_DURATION_SECONDS}, ${MAX_DISPLAY_DURATION_SECONDS}]`);
    }
    normalized.duration_seconds = seconds;
  }

  if (display.transition_in != null) {
    if (typeof display.transition_in !== 'string' || display.transition_in.trim() === '') {
      throw new Error(`${label}.transition_in must be a non-empty string`);
    }
    normalized.transition_in = display.transition_in.trim();
  }

  if (display.transition_out != null) {
    if (typeof display.transition_out !== 'string' || display.transition_out.trim() === '') {
      throw new Error(`${label}.transition_out must be a non-empty string`);
    }
    normalized.transition_out = display.transition_out.trim();
  }

  return normalized;
}

export function normalizeBundleManifest(manifest, label = 'manifest') {
  if (!isPlainObject(manifest)) {
    throw new Error(`${label} must be an object`);
  }

  const normalized = { ...manifest };
  if (manifest.scene_space && !['screen_2d', 'world_3d'].includes(manifest.scene_space)) {
    throw new Error(`${label}.scene_space '${manifest.scene_space}' is unsupported`);
  }

  normalized.assets = normalizeAssetsConfig(manifest.assets, `${label}.assets`);

  if (manifest.display !== undefined) {
    normalized.display = normalizeDisplayConfig(manifest.display, `${label}.display`);
  }

  if (manifest.params !== undefined) {
    normalized.params = normalizeParamSchema(manifest.params, `${label}.params`);
  }

  return normalized;
}

export function unpackBundle(bundleBytes, { unzipSyncImpl = null } = {}) {
  const entries = archiveEntries(bundleBytes, unzipSyncImpl);
  if (entries.length === 0) {
    throw new Error('archive is empty');
  }

  const manifestEntry =
    pickEntry(entries, ['manifest.json']) ??
    entries.find((entry) => entry.base.endsWith('_slide.json'));
  const slideWasmEntry =
    pickEntry(entries, ['slide.wasm']) ??
    entries.find((entry) => entry.base.endsWith('_slide.wasm'));
  const sidecarEntry = pickEntry(entries, ['sidecar.wasm']);

  if (!manifestEntry) {
    throw new Error('bundle is missing manifest.json');
  }
  if (!slideWasmEntry) {
    throw new Error('bundle is missing slide.wasm');
  }

  const manifest = normalizeBundleManifest(parseManifest(manifestEntry.bytes));

  const miscAssets = new Map();
  for (const entry of entries) {
    if (entry.path === manifestEntry.path || entry.path === slideWasmEntry.path) continue;
    miscAssets.set(entry.path, entry.bytes);
    miscAssets.set(entry.base, entry.bytes);
  }

  return {
    manifest,
    slideWasm: slideWasmEntry.bytes,
    sidecarWasm: sidecarEntry?.bytes ?? null,
    miscAssets,
  };
}

export function extractBundleManifest(bundleBytes, options) {
  return unpackBundle(bundleBytes, options).manifest;
}
