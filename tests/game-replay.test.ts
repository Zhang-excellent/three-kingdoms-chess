import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { newGame, resignFaction } from '../src/game.ts';
import { buildGameRecord } from '../src/game-record.ts';
import { parseGameRecord } from '../src/game-replay.ts';
import type { ReplayEvent } from '../src/game-replay.ts';

const fixture = readFileSync(resolve('tests/fixtures/三国象棋棋谱-20261029-234542.md'), 'utf8');

test('legacy 60-step record restores its own initial layout and preserves incomplete final events', () => {
  const parsed = parseGameRecord(fixture);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const replay = parsed.replay;
  assert.equal(replay.rulesVersion, 'independent-win-loss-draw-v1');
  assert.equal(replay.moves.length, 60);
  assert.equal(replay.frames.length, 61);
  assert.deepEqual(replay.initialCounts, { wei: 16, shu: 7, wu: 6 });
  assert.deepEqual(replay.reconstructedCounts, { wei: 14, shu: 4, wu: 4 });
  assert.deepEqual(replay.declaredFinalCounts, { wei: 14, shu: 0, wu: 0 });
  assert.equal(replay.declaredWinner, 'wei');
  assert.equal(replay.frames[60].status, 'playing');
  assert.deepEqual(replay.frames[60].pieces.filter(piece => piece.kind === 'king').map(piece => piece.faction).sort(), ['shu', 'wei', 'wu']);
  assert.equal(replay.warnings.length, 1);
  assert.match(replay.warnings[0].message, /缺少认输或出局事件/);
  assert.match(replay.warnings[0].details.join('\n'), /第 60 步后：魏14、蜀4、吴4/);
  assert.match(replay.warnings[0].details.join('\n'), /文件导出时子力：魏14、蜀0、吴0/);
});

test('legacy replay snapshots restore captures and support arbitrary jumps', () => {
  const parsed = parseGameRecord(fixture);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const { frames } = parsed.replay;
  assert.ok(frames[12].pieces.some(piece => piece.faction === 'wu' && piece.kind === 'pawn' && piece.x === 6 && piece.y === 5));
  assert.equal(frames[13].pieces.some(piece => piece.faction === 'wu' && piece.kind === 'pawn' && piece.x === 6 && piece.y === 5), false);
  assert.ok(frames[13].pieces.some(piece => piece.faction === 'wei' && piece.kind === 'pawn' && piece.x === 6 && piece.y === 5));
  assert.equal(frames[12].pieces.length, frames[13].pieces.length + 1);
  assert.equal(frames[0].pieces.length, 29);
  assert.equal(frames[60].history.length, 60);
  assert.equal(frames[60].lastMove?.number, 60);
  assert.equal(frames[0].history.length, 0);
});

test('structured version-one records replay real resignation and final result events', () => {
  const first = resignFaction(newGame(), 'shu');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const finished = resignFaction(first.game, 'wu');
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  const events: ReplayEvent[] = [
    { type: 'resign', step: 0, faction: 'shu' },
    { type: 'resign', step: 0, faction: 'wu' },
  ];
  const markdown = buildGameRecord(finished.game, new Date(2026, 10, 3, 10, 0, 0), events);
  assert.match(markdown, /"format": "three-kingdoms-chess-record"/);
  assert.match(markdown, /"coordinateSystem": "code-zero-based"/);
  const parsed = parseGameRecord(markdown);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.replay.source, 'structured');
  assert.equal(parsed.replay.frames[0].status, 'finished');
  assert.equal(parsed.replay.frames[0].winner, 'wei');
  assert.deepEqual(parsed.replay.frames[0].results, { wei: 'won', shu: 'lost', wu: 'lost' });
  assert.deepEqual(parsed.replay.reconstructedCounts, { wei: 16, shu: 0, wu: 0 });
  assert.equal(parsed.replay.warnings.length, 0);
});

test('malformed and unknown records fail without inventing replay data', () => {
  const badCoordinate = fixture.replace('1. 曹操 · 炮 (2, 8) → (2, 6)', '1. 曹操 · 炮 (10, 8) → (2, 6)');
  const coordinateResult = parseGameRecord(badCoordinate);
  assert.equal(coordinateResult.ok, false);
  if (!coordinateResult.ok) assert.match(coordinateResult.error, /第 1 步坐标超出棋盘范围/);

  const missingMove = fixture.replace('60. 曹操 · 车 (4, 8) → (4, 3)；吃掉蜀方车\n', '');
  const missingResult = parseGameRecord(missingMove);
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.match(missingResult.error, /声明总步数为 60，实际找到 59 行/);

  const unknownVersion = fixture.replace('independent-win-loss-draw-v1', 'unknown-rules-v99');
  const unknownResult = parseGameRecord(unknownVersion);
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.match(unknownResult.error, /暂不支持规则版本/);
});
