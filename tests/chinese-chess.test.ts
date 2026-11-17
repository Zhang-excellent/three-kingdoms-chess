import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHINESE_CHESS_RULES_VERSION,
  allLegalChineseMoves,
  legalChineseMoves,
  newChineseGame,
  playChineseMove,
  resignChineseGame,
  validChineseGame,
} from '../src/chinese-chess.ts';
import type { ChineseGame, ChinesePiece } from '../src/chinese-chess.ts';

const piece = (game: ChineseGame, id: string): ChinesePiece => {
  const found = game.pieces.find(item => item.id === id);
  if (!found) throw new Error(`Missing piece ${id}`);
  return found;
};

test('classic Chinese chess starts with 32 pieces, red to move and valid layout', () => {
  const game = newChineseGame();
  assert.equal(game.rulesVersion, CHINESE_CHESS_RULES_VERSION);
  assert.equal(game.pieces.length, 32);
  assert.equal(game.pieces.filter(piece => piece.side === 'red').length, 16);
  assert.equal(game.pieces.filter(piece => piece.side === 'black').length, 16);
  assert.equal(game.pieces.filter(piece => piece.kind === 'king').length, 2);
  assert.equal(game.pieces.filter(piece => piece.kind === 'pawn').length, 10);
  assert.equal(game.turn, 'red');
  assert.equal(validChineseGame(game), true);
  assert.equal(allLegalChineseMoves(game).length > 0, true);
});

test('classic Chinese chess enforces horse leg, elephant eye and cannon screen', () => {
  const game = newChineseGame();
  assert.deepEqual(legalChineseMoves(game.pieces, piece(game, 'red-horse-1-9')).map(point => [point.x, point.y]).sort(), [
    [0, 7], [2, 7],
  ].sort());
  assert.deepEqual(legalChineseMoves(game.pieces, piece(game, 'red-elephant-2-9')).map(point => [point.x, point.y]).sort(), [
    [0, 7], [4, 7],
  ].sort());

  const custom: ChineseGame = {
    ...newChineseGame(),
    pieces: [
      { id: 'red-cannon', side: 'red', kind: 'cannon', x: 0, y: 5 },
      { id: 'screen', side: 'black', kind: 'pawn', x: 0, y: 4 },
      { id: 'target', side: 'black', kind: 'rook', x: 0, y: 3 },
      { id: 'red-king', side: 'red', kind: 'king', x: 4, y: 9 },
      { id: 'black-king', side: 'black', kind: 'king', x: 4, y: 0 },
      { id: 'blocker', side: 'red', kind: 'pawn', x: 4, y: 5 },
    ],
  };
  const cannonMoves = legalChineseMoves(custom.pieces, custom.pieces[0]);
  assert.equal(cannonMoves.some(point => point.x === 0 && point.y === 3), true);
  assert.equal(cannonMoves.some(point => point.x === 0 && point.y === 2), false);
});

test('a move exposing the two kings prevents that move and rejected moves do not mutate state', () => {
  const game: ChineseGame = {
    ...newChineseGame(),
    pieces: [
      { id: 'red-king', side: 'red', kind: 'king', x: 4, y: 9 },
      { id: 'black-king', side: 'black', kind: 'king', x: 4, y: 0 },
      { id: 'screen', side: 'red', kind: 'rook', x: 4, y: 5 },
    ],
  };
  const before = structuredClone(game);
  assert.equal(legalChineseMoves(game.pieces, game.pieces[2]).some(point => point.x === 3 && point.y === 5), false);
  const rejected = playChineseMove(game, 'screen', { x: 3, y: 5 });
  assert.equal(rejected.ok, false);
  assert.deepEqual(game, before);
});

test('checkmate ends classic Chinese chess and resignation awards the other side', () => {
  const mating: ChineseGame = {
    ...newChineseGame(),
    pieces: [
      { id: 'red-king', side: 'red', kind: 'king', x: 4, y: 9 },
      { id: 'red-rook', side: 'red', kind: 'rook', x: 4, y: 2 },
      { id: 'red-rank-rook', side: 'red', kind: 'rook', x: 0, y: 0 },
      { id: 'black-king', side: 'black', kind: 'king', x: 4, y: 0 },
    ],
  };
  const win = playChineseMove(mating, 'red-rook', { x: 4, y: 1 });
  assert.equal(win.ok, true);
  if (!win.ok) return;
  assert.equal(win.game.status, 'finished');
  assert.equal(win.game.winner, 'red');
  assert.equal(win.game.endReason, 'checkmate');
  const resigned = resignChineseGame(newChineseGame(), 'black');
  assert.equal(resigned.winner, 'red');
  assert.equal(resigned.endReason, 'resignation');
});
