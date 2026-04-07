/**
 * fixed_step.js — Fixed-timestep simulation scheduler.
 *
 * A pure state-machine with no browser or WebGPU dependencies.
 * Accumulates wall-clock deltas and drains them in fixed-size steps,
 * producing an interpolation alpha for smooth rendering.
 */

const DEFAULT_FIXED_STEP_MS = 1000 / 60;
const DEFAULT_MAX_FRAME_DELTA_MS = 50;
const DEFAULT_MAX_FIXED_UPDATES_PER_FRAME = 4;
const MAX_INTERPOLATION_ALPHA = 0.999999;

function clampFrameInterval(rawDeltaMs, maxFrameDeltaMs) {
  return Math.max(0, Math.min(maxFrameDeltaMs, rawDeltaMs));
}

export function createFixedStepScheduler(config = {}) {
  return {
    fixedStepMs: Math.max(0.001, Number(config.fixedStepMs) || DEFAULT_FIXED_STEP_MS),
    maxFrameDeltaMs: Math.max(0, Number(config.maxFrameDeltaMs) || DEFAULT_MAX_FRAME_DELTA_MS),
    maxUpdatesPerFrame: Math.max(
      1,
      Math.floor(Number(config.maxUpdatesPerFrame) || DEFAULT_MAX_FIXED_UPDATES_PER_FRAME),
    ),
    accumulatorMs: 0,
    simulationTimeMs: 0,
    lastTimestampMs: null,
  };
}

export function resetFixedStepScheduler(scheduler) {
  scheduler.accumulatorMs = 0;
  scheduler.simulationTimeMs = 0;
  scheduler.lastTimestampMs = null;
  return scheduler;
}

export function advanceFixedStepScheduler(scheduler, timestampMs, out = {}) {
  const safeTimestampMs = Number.isFinite(timestampMs)
    ? timestampMs
    : (scheduler.lastTimestampMs ?? 0);
  const lastTimestampMs = scheduler.lastTimestampMs;

  out.fixedStepMs = scheduler.fixedStepMs;
  out.rawDeltaMs = 0;
  out.clampedDeltaMs = 0;
  out.fixedSteps = 0;
  out.alpha = 0;
  out.overloadClamped = false;
  out.accumulatorMs = scheduler.accumulatorMs;
  out.simulationTimeMs = scheduler.simulationTimeMs;
  out.renderTimeMs = scheduler.simulationTimeMs;

  scheduler.lastTimestampMs = safeTimestampMs;
  if (lastTimestampMs == null) {
    return out;
  }

  out.rawDeltaMs = Math.max(0, safeTimestampMs - lastTimestampMs);
  out.clampedDeltaMs = clampFrameInterval(out.rawDeltaMs, scheduler.maxFrameDeltaMs);
  scheduler.accumulatorMs += out.clampedDeltaMs;

  while (
    scheduler.accumulatorMs >= scheduler.fixedStepMs &&
    out.fixedSteps < scheduler.maxUpdatesPerFrame
  ) {
    scheduler.accumulatorMs -= scheduler.fixedStepMs;
    scheduler.simulationTimeMs += scheduler.fixedStepMs;
    out.fixedSteps += 1;
  }

  if (scheduler.accumulatorMs >= scheduler.fixedStepMs) {
    out.overloadClamped = true;
    scheduler.accumulatorMs = Math.min(
      scheduler.accumulatorMs,
      Math.max(0, scheduler.fixedStepMs - 0.0001),
    );
  }

  out.accumulatorMs = scheduler.accumulatorMs;
  out.simulationTimeMs = scheduler.simulationTimeMs;
  out.alpha = Math.min(
    MAX_INTERPOLATION_ALPHA,
    scheduler.fixedStepMs > 0 ? (scheduler.accumulatorMs / scheduler.fixedStepMs) : 0,
  );
  out.renderTimeMs = scheduler.simulationTimeMs + scheduler.accumulatorMs;
  return out;
}
