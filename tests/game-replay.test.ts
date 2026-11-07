import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drawGame, newGame, playMove, resignFaction } from '../src/game.ts';
import type { Game } from '../src/game.ts';
import { buildGameRecord } from '../src/game-record.ts';
import { parseGameRecord } from '../src/game-replay.ts';
import type { ReplayEvent } from '../src/game-replay.ts';

const fixture = readFileSync(resolve('tests/fixtures/三国象棋棋谱-20261029-234542.md'), 'utf8');

function playOscillatingMoves(count: number): Game {
  let game = newGame();
  for (let index = 0; index < count; index++) {
    const cycle = Math.floor(index / 3), faction = index % 3;
    const action = faction === 0
      ? { pieceId: 'wei-rook-0-9', to: cycle % 2 === 0 ? { x: 0, y: 8 } : { x: 0, y: 9 } }
      : faction === 1
        ? { pieceId: 'shu-rook-8-0', to: cycle % 2 === 0 ? { x: 8, y: 1 } : { x: 8, y: 0 } }
        : { pieceId: 'wu-rook-0-0', to: cycle % 2 === 0 ? { x: 0, y: 1 } : { x: 0, y: 0 } };
    const result = playMove(game, action.pieceId, action.to);
    if (!result.ok) assert.fail(result.error);
    game = result.game;
  }
  return game;
}

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

test('structured replay separates the 43rd move actor from the draw-ending waiting faction', () => {
  const afterMoves = playOscillatingMoves(43);
  assert.equal(afterMoves.turn, 'shu');
  const drawn = drawGame(afterMoves);
  assert.equal(drawn.ok, true);
  if (!drawn.ok) return;
  assert.equal(drawn.game.turn, null);
  assert.equal(drawn.game.turnBeforeEnd, 'shu');

  const parsed = parseGameRecord(buildGameRecord(drawn.game, new Date(2026, 10, 7, 10, 0, 0)));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const replay = parsed.replay;
  assert.equal(replay.moves.length, 43);
  assert.equal(replay.moves[42].faction, 'wei');
  assert.equal(replay.moves[42].kind, 'rook');
  assert.equal(replay.frames[0].turn, 'wei');
  assert.equal(replay.frames[0].turnSlot, 0);
  assert.equal(replay.frames[42].status, 'playing');
  assert.equal(replay.frames[42].turn, 'wei');
  assert.equal(replay.frames[43].status, 'finished');
  assert.equal(replay.frames[43].winner, null);
  assert.equal(replay.frames[43].turn, null);
  assert.equal(replay.frames[43].turnBeforeEnd, 'shu');
  assert.deepEqual(replay.frames[43].results, { wei: 'draw', shu: 'draw', wu: 'draw' });
});

test('draw replay can reconstruct the ending waiting faction when older metadata omits it', () => {
  const drawn = drawGame(playOscillatingMoves(43));
  assert.equal(drawn.ok, true);
  if (!drawn.ok) return;
  const older = buildGameRecord(drawn.game).replace(/,\s*"turnBeforeEnd": "shu"/g, '');
  const parsed = parseGameRecord(older);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.replay.frames[43].turnBeforeEnd, 'shu');
});

test('replay applies resignations between moves and skips the eliminated faction in later rounds', () => {
  const move = playMove(newGame(), 'wei-pawn-0-6', { x: 0, y: 5 });
  assert.equal(move.ok, true);
  if (!move.ok) return;
  const resigned = resignFaction(move.game, 'wu');
  assert.equal(resigned.ok, true);
  if (!resigned.ok) return;
  assert.equal(resigned.game.turn, 'shu');
  const shuMove = playMove(resigned.game, 'shu-pawn-6-3', { x: 6, y: 4 });
  assert.equal(shuMove.ok, true);
  if (!shuMove.ok) return;
  assert.equal(shuMove.game.turn, 'wei');

  const parsed = parseGameRecord(buildGameRecord(shuMove.game));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.replay.frames[1].turn, 'shu');
  assert.equal(parsed.replay.frames[1].turnSlot, 1);
  assert.equal(parsed.replay.frames[2].turn, 'wei');
  assert.equal(parsed.replay.frames[2].turnSlot, 0);
  assert.deepEqual(parsed.replay.frames[2].eliminated, ['wu']);
});

test('replay rejects a missing non-move event instead of inventing the next round', () => {
  const afterResign = resignFaction(newGame(), 'wei');
  assert.equal(afterResign.ok, true);
  if (!afterResign.ok) return;
  const move = playMove(afterResign.game, 'shu-pawn-6-3', { x: 6, y: 4 });
  assert.equal(move.ok, true);
  if (!move.ok) return;
  const withoutResign = buildGameRecord({ ...move.game, events: move.game.events?.filter(event => event.type !== 'resign') ?? [] });
  const parsed = parseGameRecord(withoutResign);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /第 1 步记录为刘备行棋，但按出局和轮次应为曹操行棋/);
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
