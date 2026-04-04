import test from 'node:test';
import assert from 'node:assert/strict';

import { createTraceRecorder } from './trace_recorder.js';

test('trace recorder emits begin/end pairs', () => {
  const recorder = createTraceRecorder({ hostKind: 'web', label: 'unit' });
  const spanId = recorder.beginSpan('web.main', 'runtime', 'vzglyd_update', { dt_ms: 16 });
  recorder.endSpan(spanId, { status: '0' });
  const trace = recorder.exportTrace();
  assert.equal(trace.metadata.host_kind, 'web');
  assert.ok(trace.traceEvents.some((event) => event.ph === 'B' && event.name === 'vzglyd_update'));
  assert.ok(trace.traceEvents.some((event) => event.ph === 'E' && event.name === 'vzglyd_update'));
});

test('trace recorder emits complete events', () => {
  const recorder = createTraceRecorder({ hostKind: 'web', label: 'unit' });
  recorder.complete('web.main', 'renderer', 'render_frame', 4.5, { fps: 60 }, 24.5);
  const trace = recorder.exportTrace();
  assert.ok(trace.traceEvents.some((event) => event.ph === 'X' && event.name === 'render_frame'));
});
