import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCanvasRenderSize } from './canvas_sizing.js';

test('keeps the legacy 640x480 floor for small containers', () => {
  assert.deepEqual(
    computeCanvasRenderSize(320, 240, 1),
    { width: 640, height: 480 },
  );
});

test('matches container size on standard-density displays up to the cap', () => {
  assert.deepEqual(
    computeCanvasRenderSize(960, 720, 1),
    { width: 960, height: 720 },
  );
});

test('caps large or high-density targets to 1280x960', () => {
  assert.deepEqual(
    computeCanvasRenderSize(1440, 1080, 2),
    { width: 1280, height: 960 },
  );
});
