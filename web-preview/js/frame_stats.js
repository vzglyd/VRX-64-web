const ROLLING_SAMPLE_LIMIT = 120;

function updateRollingAverage(current, sample, sampleCount) {
  if (sampleCount <= 1) {
    return sample;
  }

  const weight = Math.min(sampleCount, ROLLING_SAMPLE_LIMIT);
  return current + ((sample - current) / weight);
}

export function createFrameStats() {
  return {
    frames: 0,
    lastUpdateMs: 0,
    avgUpdateMs: 0,
    lastOverlayUploadMs: 0,
    avgOverlayUploadMs: 0,
    lastDynamicUploadMs: 0,
    avgDynamicUploadMs: 0,
    lastRenderMs: 0,
    avgRenderMs: 0,
    overlayUploadCount: 0,
    dynamicUploadCount: 0,
  };
}

export function recordFrameStats(stats, sample = {}) {
  stats.frames += 1;

  stats.lastUpdateMs = sample.updateMs ?? 0;
  stats.lastOverlayUploadMs = sample.overlayUploadMs ?? 0;
  stats.lastDynamicUploadMs = sample.dynamicUploadMs ?? 0;
  stats.lastRenderMs = sample.renderMs ?? 0;

  stats.avgUpdateMs = updateRollingAverage(stats.avgUpdateMs, stats.lastUpdateMs, stats.frames);
  stats.avgOverlayUploadMs = updateRollingAverage(
    stats.avgOverlayUploadMs,
    stats.lastOverlayUploadMs,
    stats.frames,
  );
  stats.avgDynamicUploadMs = updateRollingAverage(
    stats.avgDynamicUploadMs,
    stats.lastDynamicUploadMs,
    stats.frames,
  );
  stats.avgRenderMs = updateRollingAverage(stats.avgRenderMs, stats.lastRenderMs, stats.frames);

  if (sample.overlayUploaded) {
    stats.overlayUploadCount += 1;
  }
  if (sample.dynamicUploaded) {
    stats.dynamicUploadCount += 1;
  }

  return stats;
}
