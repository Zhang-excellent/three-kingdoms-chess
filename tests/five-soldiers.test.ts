import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIVE_SOLDIERS_RULES_VERSION,
  fivePieceCounts,
  legalFiveMoves,
  newFiveGame,
  playFiveMove,
  resignFiveGame,
  validFiveGame,
} from '../src/five-soldiers.ts';
import type { FiveGame, FivePiece } from '../src/five-soldiers.ts';

const piece = (game: FiveGame, id: string): FivePiece => {
  const found = game.pieces.find(item => item.id === id);
  if (!found) throw new Error(`Missing piece ${id}`);
  return found;
};

test('five soldiers starts with the ten-piece red alliance and standard sixteen black pieces', () => {
  const game = newFiveGame();
  assert.equal(game.rulesVersion, FIVE_SOLDIERS_RULES_VERSION);
  assert.deepEqual(fivePieceCounts(game), { red: 10, black: 16 });
  assert.equal(game.pieces.length, 26);
  assert.equal(game.turn, 'red');
  assert.equal(game.movesRemaining, 2);
  assert.equal(validFiveGame(game), true);
  assert.deepEqual(game.pieces.filter(item => item.side === 'red' && item.kind === 'pawn').map(item => [item.x, item.y]), [
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
  ]);
  assert.equal(piece(game, 'red-general-4-9').kind, 'general');
  assert.equal(piece(game, 'red-advisor-3-9').kind, 'advisor');
  assert.equal(piece(game, 'red-advisor-5-9').kind, 'advisor');
  assert.equal(piece(game, 'black-general-4-0').kind, 'general');
});

test('five soldiers preserves standard horse leg, elephant river and cannon screen rules', () => {
  const game = newFiveGame();
  assert.deepEqual(legalFiveMoves(game.pieces, piece(game, 'black-horse-1-0'))
    .map(move => [move.x, move.y]).sort((left, right) => left[0] - right[0]), [[0, 2], [2, 2]]);
  assert.equal(legalFiveMoves(game.pieces, piece(game, 'red-elephant-2-9')).some(move => move.y < 5), false);

  const custom: FiveGame = {
    ...newFiveGame(),
    pieces: [
      { id: 'red-cannon', side: 'red', kind: 'cannon', x: 0, y: 5 },
      { id: 'screen', side: 'black', kind: 'pawn', x: 0, y: 4 },
      { id: 'target', side: 'black', kind: 'rook', x: 0, y: 3 },
      { id: 'black-general', side: 'black', kind: 'general', x: 4, y: 0 },
      { id: 'red-general', side: 'red', kind: 'general', x: 4, y: 9 },
    ],
  };
  assert.equal(legalFiveMoves(custom.pieces, custom.pieces[0]).some(move => move.x === 0 && move.y === 3), true);
  assert.equal(legalFiveMoves(custom.pieces, custom.pieces[0]).some(move => move.x === 0 && move.y === 2), false);
});

test('five soldiers gives red two consecutive moves and black one move', () => {
  const game = newFiveGame();
  const before = structuredClone(game);
  const rejected = playFiveMove(game, 'black-horse-1-0', { x: 0, y: 2 });
  assert.equal(rejected.ok, false);
  assert.deepEqual(game, before);

  const first = playFiveMove(game, 'red-pawn-0-6', { x: 0, y: 5 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.game.turn, 'red');
  assert.equal(first.game.movesRemaining, 1);
  assert.equal(first.game.history.length, 1);
  assert.equal(game.history.length, 0);
  const second = playFiveMove(first.game, 'red-pawn-2-6', { x: 2, y: 5 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.game.turn, 'black');
  assert.equal(second.game.movesRemaining, 1);
  const black = playFiveMove(second.game, 'black-horse-1-0', { x: 0, y: 2 });
  assert.equal(black.ok, true);
  if (!black.ok) return;
  assert.equal(black.game.turn, 'red');
  assert.equal(black.game.movesRemaining, 2);
});

test('five soldiers captures the opposing general and leaves rejected moves untouched', () => {
  const captureReady: FiveGame = {
    ...newFiveGame(),
    pieces: [
      { id: 'red-pawn', side: 'red', kind: 'pawn', x: 4, y: 2 },
      { id: 'black-general', side: 'black', kind: 'general', x: 4, y: 1 },
      { id: 'red-general', side: 'red', kind: 'general', x: 4, y: 9 },
    ],
    turn: 'red',
    movesRemaining: 2,
  };
  const winning = playFiveMove(captureReady, 'red-pawn', { x: 4, y: 1 });
  assert.equal(winning.ok, true);
  if (!winning.ok) return;
  assert.equal(winning.game.status, 'finished');
  assert.equal(winning.game.winner, 'red');
  assert.equal(winning.game.history[0].captured?.kind, 'general');
});

test('five soldiers resignation awards the other side without inventing moves', () => {
  const game = newFiveGame();
  const finished = resignFiveGame(game, 'black');
  assert.equal(finished.status, 'finished');
  assert.equal(finished.winner, 'red');
  assert.equal(finished.history.length, 0);
  assert.equal(game.status, 'playing');
});
