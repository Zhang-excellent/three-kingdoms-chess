import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIST_BOARD_CELLS,
  MIST_CHESS_RULES_VERSION,
  allMistMoves,
  mistVisibleCells,
  newMistGame,
  playMistMove,
  projectMistGame,
  validMistGame,
} from '../src/mist-chess.ts';
import type { MistGame } from '../src/mist-chess.ts';
import type { ChinesePiece } from '../src/chinese-chess.ts';

const customGame = (pieces: ChinesePiece[], turn: 'red' | 'black' = 'red'): MistGame => ({
  ...newMistGame(),
  pieces,
  turn,
});

const visible = (game: MistGame, side: 'red' | 'black', x: number, y: number): boolean =>
  mistVisibleCells(game, side).some(point => point.x === x && point.y === y);

test('mist chess starts from the classic 32-piece layout and projects different opening views', () => {
  const game = newMistGame();
  assert.equal(game.rulesVersion, MIST_CHESS_RULES_VERSION);
  assert.equal(game.pieces.length, 32);
  assert.equal(game.turn, 'red');
  assert.equal(validMistGame(game), true);

  const red = projectMistGame(game, 'red');
  const black = projectMistGame(game, 'black');
  assert.equal(red.pieces.some(piece => piece.id === 'black-king-4-0'), false);
  assert.equal(black.pieces.some(piece => piece.id === 'red-king-4-9'), false);
  assert.equal(red.pieces.some(piece => piece.id === 'black-horse-1-0'), true);
  assert.equal(black.pieces.some(piece => piece.id === 'red-horse-1-9'), true);
  assert.notDeepEqual(red.visibleCells, black.visibleCells);
  assert.equal(red.history.length, 0);
  assert.equal(black.history.length, 0);
});

test('visibility uses destinations only and never lights rook paths, horse legs, elephant eyes or cannon screens automatically', () => {
  const game = customGame([
    { id: 'red-rook', side: 'red', kind: 'rook', x: 0, y: 5 },
    { id: 'red-horse', side: 'red', kind: 'horse', x: 4, y: 5 },
    { id: 'horse-leg', side: 'red', kind: 'pawn', x: 5, y: 5 },
    { id: 'red-elephant', side: 'red', kind: 'elephant', x: 2, y: 9 },
    { id: 'elephant-eye', side: 'red', kind: 'pawn', x: 3, y: 8 },
    { id: 'red-cannon', side: 'red', kind: 'cannon', x: 8, y: 5 },
    { id: 'hidden-screen', side: 'black', kind: 'pawn', x: 8, y: 4 },
    { id: 'cannon-target', side: 'black', kind: 'rook', x: 8, y: 3 },
    { id: 'rook-blocker', side: 'black', kind: 'pawn', x: 0, y: 2 },
    { id: 'rook-beyond', side: 'black', kind: 'horse', x: 0, y: 1 },
    { id: 'red-king', side: 'red', kind: 'king', x: 4, y: 9 },
    { id: 'black-king', side: 'black', kind: 'king', x: 3, y: 0 },
  ]);
  const red = projectMistGame(game, 'red');

  assert.equal(visible(game, 'red', 0, 4), true);
  assert.equal(visible(game, 'red', 0, 2), true);
  assert.equal(visible(game, 'red', 0, 1), false);
  assert.equal(visible(game, 'red', 6, 6), false);
  assert.equal(visible(game, 'red', 2, 7), false);
  assert.equal(visible(game, 'red', 8, 4), false);
  assert.equal(visible(game, 'red', 8, 3), true);
  assert.equal(red.pieces.some(piece => piece.id === 'cannon-target'), true);
  assert.equal(red.pieces.some(piece => piece.id === 'hidden-screen'), false);
});

test('visibility is retained for the waiting side and enemies enter or leave immediately', () => {
  const waiting = customGame([
    { id: 'red-rook', side: 'red', kind: 'rook', x: 0, y: 5 },
    { id: 'red-king', side: 'red', kind: 'king', x: 4, y: 9 },
    { id: 'black-king', side: 'black', kind: 'king', x: 3, y: 0 },
    { id: 'scout', side: 'black', kind: 'pawn', x: 0, y: 3 },
  ], 'black');
  assert.equal(projectMistGame(waiting, 'red').pieces.some(piece => piece.id === 'scout'), true);
  assert.equal(visible(waiting, 'red', 0, 3), true);

  const outOfRange = customGame([
    ...waiting.pieces.filter(piece => piece.id !== 'scout'),
    { id: 'scout', side: 'black', kind: 'pawn', x: 8, y: 8 },
  ], 'black');
  assert.equal(projectMistGame(outOfRange, 'red').pieces.some(piece => piece.id === 'scout'), false);
  assert.equal(visible(outOfRange, 'red', 8, 8), false);
});

test('mist chess permits exposing or facing kings and captures the opposing king directly', () => {
  const exposing = customGame([
    { id: 'red-king', side: 'red', kind: 'king', x: 4, y: 9 },
    { id: 'black-king', side: 'black', kind: 'king', x: 4, y: 0 },
    { id: 'screen', side: 'red', kind: 'rook', x: 4, y: 5 },
  ]);
  const moved = playMistMove(exposing, 'screen', { x: 3, y: 5 });
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.equal(moved.game.status, 'playing');
  assert.equal(allMistMoves(moved.game, 'black').some(move =>
    move.pieceId === 'black-king' && move.to.x === 4 && move.to.y === 9), true);

  const facing = customGame([
    { id: 'red-king', side: 'red', kind: 'king', x: 4, y: 9 },
    { id: 'black-king', side: 'black', kind: 'king', x: 4, y: 0 },
  ]);
  const captured = playMistMove(facing, 'red-king', { x: 4, y: 0 });
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.game.status, 'finished');
  assert.equal(captured.game.winner, 'red');
  assert.equal(captured.game.endReason, 'king-captured');
  const full = projectMistGame(captured.game, 'black');
  assert.equal(full.fullBoardVisible, true);
  assert.equal(full.visibleCells.length, MIST_BOARD_CELLS.length);
  assert.equal(full.history.length, 1);
});

test('a side with no legal move loses and rejected moves never mutate the game', () => {
  const game = customGame([
    { id: 'red-king', side: 'red', kind: 'king', x: 4, y: 9 },
    { id: 'red-rook', side: 'red', kind: 'rook', x: 0, y: 5 },
  ]);
  const before = structuredClone(game);
  const rejected = playMistMove(game, 'red-king', { x: 8, y: 8 });
  assert.equal(rejected.ok, false);
  assert.deepEqual(game, before);

  const finished = playMistMove(game, 'red-rook', { x: 0, y: 4 });
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.game.status, 'finished');
  assert.equal(finished.game.winner, 'red');
  assert.equal(finished.game.endReason, 'stalemate');
});
