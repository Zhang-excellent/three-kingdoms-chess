import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPoint, screenPoint } from '../src/board-view.ts';

test('all 90 canonical points survive both view orientations and click mapping', () => {
  for (const flipped of [false, true]) for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
    const display = boardPoint({ x, y }, flipped);
    assert.deepEqual(screenPoint(50 + display.x * 55, 50 + display.y * 55, flipped), { x, y });
  }
  assert.deepEqual(boardPoint({ x: 2, y: 0 }, true), { x: 6, y: 9 });
  assert.deepEqual(boardPoint({ x: 6, y: 0 }, true), { x: 2, y: 9 });
  assert.equal(screenPoint(0, 0, true), null);
});
