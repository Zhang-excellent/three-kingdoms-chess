import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HORSE_CHESS_RULES_VERSION,
  legalHorseMoves,
  newHorseGame,
  playHorseMove,
  resignHorseGame,
  validHorseGame,
} from '../src/horse-chess.ts';
import type { HorseGame, HorsePiece } from '../src/horse-chess.ts';

const piece = (game: HorseGame, id: string): HorsePiece => {
  const found = game.pieces.find(item => item.id === id);
  if (!found) throw new Error(`Missing piece ${id}`);
  return found;
};

test('horse chess starts with nine horses per side and red to move', () => {
  const game = newHorseGame();
  assert.equal(game.rulesVersion, HORSE_CHESS_RULES_VERSION);
  assert.equal(game.pieces.length, 18);
  assert.equal(game.pieces.filter(piece => piece.side === 'red').length, 9);
  assert.equal(game.pieces.filter(piece => piece.side === 'black').length, 9);
  assert.equal(game.turn, 'red');
  assert.equal(validHorseGame(game), true);
});

test('horse chess enforces horse movement, horse leg blocking and captures', () => {
  const game = newHorseGame();
  assert.deepEqual(legalHorseMoves(game.pieces, piece(game, 'red-horse-1')).map(point => [point.x, point.y]).sort(), [
    [0, 7], [2, 7],
  ]);
  const blocked: HorseGame = {
    ...newHorseGame(),
    pieces: [
      { id: 'red', side: 'red', x: 2, y: 5 },
      { id: 'leg', side: 'black', x: 2, y: 4 },
      { id: 'target', side: 'black', x: 1, y: 7 },
    ],
  };
  assert.equal(legalHorseMoves(blocked.pieces, blocked.pieces[0]).some(point => point.x === 3 && point.y === 3), false);
  const capture = playHorseMove(blocked, 'red', { x: 1, y: 7 });
  assert.equal(capture.ok, true);
  if (!capture.ok) return;
  assert.equal(capture.game.pieces.length, 2);
});

test('entering the opposing central goal wins immediately without mutating rejected moves', () => {
  const game: HorseGame = {
    ...newHorseGame(),
    pieces: [
      { id: 'red', side: 'red', x: 3, y: 2 },
      { id: 'black', side: 'black', x: 0, y: 0 },
    ],
  };
  const before = structuredClone(game);
  const rejected = playHorseMove(game, 'black', { x: 1, y: 2 });
  assert.equal(rejected.ok, false);
  assert.deepEqual(game, before);
  const win = playHorseMove(game, 'red', { x: 4, y: 0 });
  assert.equal(win.ok, true);
  if (!win.ok) return;
  assert.equal(win.game.status, 'finished');
  assert.equal(win.game.winner, 'red');
  assert.equal(win.game.history.length, 1);
});

test('horse chess resignation awards the other side', () => {
  const finished = resignHorseGame(newHorseGame(), 'black');
  assert.equal(finished.status, 'finished');
  assert.equal(finished.winner, 'red');
  assert.equal(finished.history.length, 0);
});
