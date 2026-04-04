import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCustomShaderBody,
  shouldUploadRuntimeBytes,
} from './renderer.js';

const FULL_MODULE = `
@vertex
fn vs_main() -> vec4<f32> {
  return vec4<f32>(0.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}
`;

const ALT_FULL_MODULE = `
@vertex
fn vs_main() -> vec4<f32> {
  return vec4<f32>(1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}
`;

const VERTEX_ONLY = `
@vertex
fn vs_main() -> vec4<f32> {
  return vec4<f32>(0.0);
}
`;

const FRAGMENT_ONLY = `
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}
`;

test('uses a single full module as-is', () => {
  const result = normalizeCustomShaderBody({ fragment_wgsl: FULL_MODULE, vertex_wgsl: null });
  assert.equal(result.error, null);
  assert.equal(result.body, FULL_MODULE);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.infos, []);
});

test('combines split vertex and fragment stages', () => {
  const result = normalizeCustomShaderBody({ vertex_wgsl: VERTEX_ONLY, fragment_wgsl: FRAGMENT_ONLY });
  assert.equal(result.error, null);
  assert.equal(result.body, `${VERTEX_ONLY}\n${FRAGMENT_ONLY}`);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.infos, []);
});

test('prefers fragment_wgsl when both fields contain full modules', () => {
  const result = normalizeCustomShaderBody({ vertex_wgsl: FULL_MODULE, fragment_wgsl: ALT_FULL_MODULE });
  assert.equal(result.error, null);
  assert.equal(result.body, ALT_FULL_MODULE);
  assert.match(result.warnings[0], /using fragment_wgsl/);
  assert.deepEqual(result.infos, []);
});

test('downgrades identical full-module duplication to info', () => {
  const result = normalizeCustomShaderBody({ vertex_wgsl: FULL_MODULE, fragment_wgsl: FULL_MODULE });
  assert.equal(result.error, null);
  assert.equal(result.body, FULL_MODULE);
  assert.deepEqual(result.warnings, []);
  assert.match(result.infos[0], /same full shader module/);
});

test('ignores a secondary stage blob when one field already contains a full module', () => {
  const result = normalizeCustomShaderBody({ vertex_wgsl: FULL_MODULE, fragment_wgsl: FRAGMENT_ONLY });
  assert.equal(result.error, null);
  assert.equal(result.body, FULL_MODULE);
  assert.match(result.warnings[0], /ignoring fragment_wgsl/);
  assert.deepEqual(result.infos, []);
});

test('rejects incomplete single-stage payloads', () => {
  const result = normalizeCustomShaderBody({ vertex_wgsl: VERTEX_ONLY, fragment_wgsl: null });
  assert.equal(result.body, null);
  assert.match(result.error, /incomplete custom shader payload/);
  assert.deepEqual(result.infos, []);
});

test('rejects duplicate entry points inside one shader blob', () => {
  const duplicateVertex = `${VERTEX_ONLY}\n${VERTEX_ONLY}\n${FRAGMENT_ONLY}`;
  const result = normalizeCustomShaderBody({ vertex_wgsl: duplicateVertex, fragment_wgsl: null });
  assert.equal(result.body, null);
  assert.match(result.error, /duplicate entry points inside a single source blob/);
  assert.deepEqual(result.infos, []);
});

test('skips runtime uploads when the byte fingerprint is unchanged', () => {
  const first = shouldUploadRuntimeBytes(null, new Uint8Array([1, 2, 3, 4]));
  assert.equal(first.shouldUpload, true);

  const second = shouldUploadRuntimeBytes(first.fingerprint, new Uint8Array([1, 2, 3, 4]));
  assert.equal(second.shouldUpload, false);
});

test('uploads runtime bytes again when the payload changes', () => {
  const first = shouldUploadRuntimeBytes(null, new Uint8Array([1, 2, 3, 4]));
  const second = shouldUploadRuntimeBytes(first.fingerprint, new Uint8Array([1, 2, 3, 5]));

  assert.equal(second.shouldUpload, true);
  assert.notEqual(second.fingerprint, first.fingerprint);
});
