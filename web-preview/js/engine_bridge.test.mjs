import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSlideTraceContext } from './engine_bridge.js';

test('buildSlideTraceContext includes playlist identity when available', () => {
  const trace = buildSlideTraceContext(
    { manifest: { name: 'Air Quality' } },
    { slidePath: 'weather/air_quality.vzglyd', slideIndex: 3 },
  );

  assert.equal(trace.thread, 'slide:3:weather/air_quality.vzglyd');
  assert.equal(trace.sidecarThread, 'sidecar:3:weather/air_quality.vzglyd');
  assert.deepEqual(trace.args, {
    slide_path: 'weather/air_quality.vzglyd',
    slide_index: 3,
  });
});

test('buildSlideTraceContext falls back to manifest name for single bundles', () => {
  const trace = buildSlideTraceContext({ manifest: { name: 'Clock' } }, null);

  assert.equal(trace.thread, 'slide:Clock');
  assert.equal(trace.sidecarThread, 'sidecar:Clock');
  assert.deepEqual(trace.args, {});
});
