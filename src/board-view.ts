import type { Point } from './game.ts';

/** Convert between canonical board coordinates and the current viewer's display. */
export function boardPoint(point: Point, flipped: boolean): Point {
  return flipped ? { x: 8 - point.x, y: 9 - point.y } : { x: point.x, y: point.y };
}

export function screenPoint(x: number, y: number, flipped: boolean): Point | null {
  const displayX = Math.round((x - 50) / 55);
  const displayY = Math.round((y - 50) / 55);
  if (displayX < 0 || displayX > 8 || displayY < 0 || displayY > 9
    || Math.abs(x - (50 + displayX * 55)) > 26 || Math.abs(y - (50 + displayY * 55)) > 26) return null;
  return boardPoint({ x: displayX, y: displayY }, flipped);
}
