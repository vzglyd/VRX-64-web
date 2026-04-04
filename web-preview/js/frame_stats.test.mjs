import test from 'node:test';
import assert from 'node:assert/strict';

import { createFrameStats, recordFrameStats } from './frame_stats.js';

test('records last-frame timings and rolling averages', () => {
  const stats = createFrameStats();

  recordFrameStats(stats, {
    updateMs: 1,
    overlayUploadMs: 2,
    dynamicUploadMs: 3,
    renderMs: 4,
    overlayUploaded: true,
  });

  assert.equal(stats.frames, 1);
  assert.equal(stats.lastUpdateMs, 1);
  assert.equal(stats.lastOverlayUploadMs, 2);
  assert.equal(stats.lastDynamicUploadMs, 3);
  assert.equal(stats.lastRenderMs, 4);
  assert.equal(stats.avgUpdateMs, 1);
  assert.equal(stats.avgOverlayUploadMs, 2);
  assert.equal(stats.avgDynamicUploadMs, 3);
  assert.equal(stats.avgRenderMs, 4);
  assert.equal(stats.overlayUploadCount, 1);
  assert.equal(stats.dynamicUploadCount, 0);

  recordFrameStats(stats, {
    updateMs: 3,
    overlayUploadMs: 0,
    dynamicUploadMs: 1,
    renderMs: 5,
    dynamicUploaded: true,
  });

  assert.equal(stats.frames, 2);
  assert.equal(stats.lastUpdateMs, 3);
  assert.equal(stats.lastOverlayUploadMs, 0);
  assert.equal(stats.lastDynamicUploadMs, 1);
  assert.equal(stats.lastRenderMs, 5);
  assert.equal(stats.avgUpdateMs, 2);
  assert.equal(stats.avgOverlayUploadMs, 1);
  assert.equal(stats.avgDynamicUploadMs, 2);
  assert.equal(stats.avgRenderMs, 4.5);
  assert.equal(stats.overlayUploadCount, 1);
  assert.equal(stats.dynamicUploadCount, 1);
});
