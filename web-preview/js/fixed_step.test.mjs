import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceFixedStepScheduler,
  createFixedStepScheduler,
  resetFixedStepScheduler,
} from './fixed_step.js';

test('fixed-step scheduler clamps incoming delta and advances in fixed quanta', () => {
  const scheduler = createFixedStepScheduler({
    fixedStepMs: 1000 / 60,
    maxFrameDeltaMs: 50,
    maxUpdatesPerFrame: 4,
  });
  const frame = {};

  advanceFixedStepScheduler(scheduler, 100, frame);
  advanceFixedStepScheduler(scheduler, 160, frame);

  assert.equal(frame.rawDeltaMs, 60);
  assert.equal(frame.clampedDeltaMs, 50);
  assert.equal(frame.fixedSteps, 2);
  assert.equal(frame.overloadClamped, false);
  assert.ok(frame.alpha > 0.9 && frame.alpha < 1);
  assert.ok(frame.simulationTimeMs > 33 && frame.simulationTimeMs < 34);
  assert.ok(frame.renderTimeMs > frame.simulationTimeMs);
});

test('fixed-step scheduler caps work per frame and drops excess accumulator time', () => {
  const scheduler = createFixedStepScheduler({
    fixedStepMs: 10,
    maxFrameDeltaMs: 50,
    maxUpdatesPerFrame: 3,
  });
  const frame = {};

  advanceFixedStepScheduler(scheduler, 0, frame);
  advanceFixedStepScheduler(scheduler, 50, frame);

  assert.equal(frame.fixedSteps, 3);
  assert.equal(frame.overloadClamped, true);
  assert.ok(frame.alpha > 0.9 && frame.alpha < 1);
  assert.ok(frame.accumulatorMs < 10);
});

test('fixed-step scheduler reset clears accumulated state', () => {
  const scheduler = createFixedStepScheduler({
    fixedStepMs: 10,
    maxFrameDeltaMs: 50,
    maxUpdatesPerFrame: 4,
  });
  const frame = {};

  advanceFixedStepScheduler(scheduler, 0, frame);
  advanceFixedStepScheduler(scheduler, 25, frame);
  resetFixedStepScheduler(scheduler);
  advanceFixedStepScheduler(scheduler, 40, frame);

  assert.equal(frame.rawDeltaMs, 0);
  assert.equal(frame.fixedSteps, 0);
  assert.equal(frame.simulationTimeMs, 0);
  assert.equal(frame.renderTimeMs, 0);
});
