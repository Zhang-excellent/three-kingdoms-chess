import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEAST_CHESS_RULES_VERSION,
  beastCoordinate,
  beastEffectiveRank,
  beastHasAnyLegalMove,
  beastPieceAt,
  beastPositionKey,
  createBeastGame,
  legalBeastMoves,
  newBeastGame,
  playBeastMove,
  undoBeastMove,
} from '../src/beast-chess.ts';
import type { BeastGame, BeastKind, BeastPiece, BeastSide } from '../src/beast-chess.ts';

function piece(id: string, side: BeastSide, kind: BeastKind, x: number, y: number): BeastPiece {
  return { id, side, kind, x, y };
}

const safeUpper = piece('safe-upper-cat', 'upper', 'cat', 6, 8);

function has(point: { x: number; y: number }[], x: number, y: number): boolean {
  return point.some(item => item.x === x && item.y === y);
}

test('beast chess starts with the exact sixteen-piece layout and lower moves first', () => {
  const game = newBeastGame();
  assert.equal(game.rulesVersion, BEAST_CHESS_RULES_VERSION);
  assert.equal(game.pieces.length, 16);
  assert.equal(game.turn, 'lower');
  assert.equal(game.pieces.filter(item => item.side === 'lower').length, 8);
  assert.equal(game.pieces.filter(item => item.side === 'upper').length, 8);

  const expected: Array<[BeastSide, BeastKind, number, number]> = [
    ['lower', 'tiger', 0, 0],
    ['lower', 'lion', 6, 0],
    ['lower', 'cat', 1, 1],
    ['lower', 'dog', 5, 1],
    ['lower', 'elephant', 0, 2],
    ['lower', 'wolf', 2, 2],
    ['lower', 'leopard', 4, 2],
    ['lower', 'rat', 6, 2],
    ['upper', 'lion', 0, 8],
    ['upper', 'tiger', 6, 8],
    ['upper', 'dog', 1, 7],
    ['upper', 'cat', 5, 7],
    ['upper', 'rat', 0, 6],
    ['upper', 'leopard', 2, 6],
    ['upper', 'wolf', 4, 6],
    ['upper', 'elephant', 6, 6],
  ];
  for (const [side, kind, x, y] of expected) {
    assert.equal(game.pieces.some(item => item.side === side && item.kind === kind
      && item.x === x && item.y === y), true, `${side} ${kind} ${x},${y}`);
  }
  assert.equal(beastCoordinate({ x: 0, y: 0 }), 'A1');
  assert.equal(beastCoordinate({ x: 6, y: 8 }), 'G9');
  assert.equal(game.positionCounts[beastPositionKey(game.pieces, 'lower')], 1);
});

test('beast chess alternates one move per side and rejects moves without mutating the game', () => {
  const game = newBeastGame();
  const before = structuredClone(game);
  const rejected = playBeastMove(game, 'upper-lion-0-8-8', { x: 1, y: 8 });
  assert.equal(rejected.ok, false);
  assert.deepEqual(game, before);

  const first = playBeastMove(game, 'lower-tiger-0-0-0', { x: 1, y: 0 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.game.turn, 'upper');
  assert.equal(first.game.history.length, 1);
  const second = playBeastMove(first.game, 'upper-lion-0-8-8', { x: 1, y: 8 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.game.turn, 'lower');
  assert.equal(second.game.history.length, 2);
  assert.equal(game.history.length, 0);
});

test('beast chess permits only one orthogonal land step and enforces dens, occupancy and water access', () => {
  const wolf = piece('wolf', 'lower', 'wolf', 3, 2);
  const ownBlocker = piece('blocker', 'lower', 'cat', 3, 3);
  const enemy = piece('enemy', 'upper', 'cat', 6, 8);
  const game = createBeastGame([wolf, ownBlocker, enemy]);
  const moves = legalBeastMoves(game, wolf.id);
  assert.equal(has(moves, 3, 3), false);
  assert.equal(has(moves, 2, 2), true);
  assert.equal(has(moves, 4, 2), true);
  assert.equal(has(moves, 3, 1), true);

  const diagonalGame = createBeastGame([
    piece('diagonal-wolf', 'lower', 'wolf', 3, 4),
    piece('edge-cat', 'lower', 'cat', 0, 8),
    enemy,
  ]);
  assert.equal(has(legalBeastMoves(diagonalGame, 'diagonal-wolf'), 4, 5), false);
  assert.equal(has(legalBeastMoves(diagonalGame, 'edge-cat'), -1, 8), false);

  const denGame = createBeastGame([
    piece('lower-den-piece', 'lower', 'tiger', 3, 1),
    piece('other-lower', 'lower', 'cat', 0, 8),
    enemy,
  ]);
  assert.equal(has(legalBeastMoves(denGame, 'lower-den-piece'), 3, 0), false);

  const waterGame = createBeastGame([
    piece('land-elephant', 'lower', 'elephant', 0, 3),
    piece('other-land', 'lower', 'cat', 0, 8),
    enemy,
  ]);
  assert.equal(has(legalBeastMoves(waterGame, 'land-elephant'), 1, 3), false);
});

test('beast chess enforces aquatic rat captures, water-land separation and rat-elephant exceptions', () => {
  const aquatic = createBeastGame([
    piece('lower-water-rat', 'lower', 'rat', 1, 3),
    piece('upper-water-rat', 'upper', 'rat', 1, 4),
    piece('upper-bank-elephant', 'upper', 'elephant', 0, 3),
    safeUpper,
  ]);
  const aquaticMoves = legalBeastMoves(aquatic, 'lower-water-rat');
  assert.equal(has(aquaticMoves, 1, 4), true);
  assert.equal(has(aquaticMoves, 0, 3), false);

  const bankToWater = createBeastGame([
    piece('bank-rat', 'lower', 'rat', 0, 3),
    piece('water-rat', 'upper', 'rat', 1, 3),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(bankToWater, 'bank-rat'), 1, 3), false);

  const ratAndElephant = createBeastGame([
    piece('land-rat', 'lower', 'rat', 3, 3),
    piece('land-elephant', 'upper', 'elephant', 3, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(ratAndElephant, 'land-rat'), 3, 4), true);

  const elephantAndRat = createBeastGame([
    piece('land-elephant-lower', 'lower', 'elephant', 3, 3),
    piece('land-rat-upper', 'upper', 'rat', 3, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(elephantAndRat, 'land-elephant-lower'), 3, 4), false);

  const sameRank = createBeastGame([
    piece('lower-tiger', 'lower', 'tiger', 3, 3),
    piece('upper-tiger', 'upper', 'tiger', 3, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(sameRank, 'lower-tiger'), 3, 4), true);
});

test('lion and tiger jump exactly two horizontal or three vertical river cells and are blocked by either rat', () => {
  const horizontal = createBeastGame([
    piece('horizontal-lion', 'lower', 'lion', 0, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(horizontal, 'horizontal-lion'), 3, 4), true);
  const horizontalResult = playBeastMove(horizontal, 'horizontal-lion', { x: 3, y: 4 });
  assert.equal(horizontalResult.ok, true);
  if (!horizontalResult.ok) return;
  assert.equal(horizontalResult.game.lastMove?.jumpedRiver, true);
  assert.deepEqual(horizontalResult.game.lastMove?.path, [{ x: 1, y: 4 }, { x: 2, y: 4 }]);

  const vertical = createBeastGame([
    piece('vertical-tiger', 'lower', 'tiger', 1, 2),
    safeUpper,
  ]);
  const verticalMoves = legalBeastMoves(vertical, 'vertical-tiger');
  assert.equal(has(verticalMoves, 1, 6), true);

  const friendlyBlock = createBeastGame([
    piece('blocked-friend-lion', 'lower', 'lion', 0, 4),
    piece('friendly-rat', 'lower', 'rat', 1, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(friendlyBlock, 'blocked-friend-lion'), 3, 4), false);

  const enemyBlock = createBeastGame([
    piece('blocked-enemy-lion', 'lower', 'lion', 0, 4),
    piece('enemy-rat', 'upper', 'rat', 2, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(enemyBlock, 'blocked-enemy-lion'), 3, 4), false);

  const capture = createBeastGame([
    piece('capturing-lion', 'lower', 'lion', 0, 4),
    piece('upper-tiger-at-landing', 'upper', 'tiger', 3, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(capture, 'capturing-lion'), 3, 4), true);

  const blockedCapture = createBeastGame([
    piece('capturing-tiger', 'lower', 'tiger', 0, 4),
    piece('upper-elephant-at-landing', 'upper', 'elephant', 3, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(blockedCapture, 'capturing-tiger'), 3, 4), false);

  const ownLanding = createBeastGame([
    piece('own-landing-lion', 'lower', 'lion', 0, 4),
    piece('own-landing-cat', 'lower', 'cat', 3, 4),
    safeUpper,
  ]);
  assert.equal(has(legalBeastMoves(ownLanding, 'own-landing-lion'), 3, 4), false);
});

test('traps weaken only enemy pieces, allow empty moves, and restore rank after leaving', () => {
  const ownTrap = piece('own-trap-cat', 'lower', 'cat', 2, 0);
  assert.equal(beastEffectiveRank(ownTrap), 2);

  const trappedWolf = piece('trapped-wolf', 'lower', 'wolf', 3, 7);
  assert.equal(beastEffectiveRank(trappedWolf), 0);
  const trappedGame: BeastGame = createBeastGame([
    trappedWolf,
    piece('trap-target', 'upper', 'dog', 2, 7),
    safeUpper,
  ]);
  const trappedMoves = legalBeastMoves(trappedGame, trappedWolf.id);
  assert.equal(has(trappedMoves, 2, 7), false);
  assert.equal(has(trappedMoves, 3, 6), true);
  const escaped = playBeastMove(trappedGame, trappedWolf.id, { x: 3, y: 6 });
  assert.equal(escaped.ok, true);
  if (!escaped.ok) return;
  const restored = beastPieceAt(escaped.game.pieces, { x: 3, y: 6 })!;
  assert.equal(beastEffectiveRank(restored), 4);

  const elephant = piece('trap-elephant', 'lower', 'elephant', 3, 2);
  const trappedRat = piece('trapped-enemy-rat', 'upper', 'rat', 3, 1);
  const captureTrap = createBeastGame([elephant, trappedRat, safeUpper]);
  assert.equal(beastEffectiveRank(trappedRat, { x: 3, y: 1 }), 0);
  const captured = playBeastMove(captureTrap, elephant.id, { x: 3, y: 1 });
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.game.lastMove?.captured?.id, trappedRat.id);
});

test('enemy den, capture-all and stalemate wins take precedence over halfmove draws', () => {
  const denGame = {
    ...createBeastGame([
      piece('den-rat', 'lower', 'rat', 3, 7),
      safeUpper,
    ]),
    noCaptureHalfMoves: 99,
  };
  const den = playBeastMove(denGame, 'den-rat', { x: 3, y: 8 });
  assert.equal(den.ok, true);
  if (!den.ok) return;
  assert.equal(den.game.status, 'finished');
  assert.equal(den.game.winner, 'lower');
  assert.equal(den.game.finishReason, 'den');
  assert.equal(den.game.drawReason, null);

  const captureAll = playBeastMove(createBeastGame([
    piece('capture-all-lion', 'lower', 'lion', 2, 2),
    piece('last-upper-dog', 'upper', 'dog', 3, 2),
  ]), 'capture-all-lion', { x: 3, y: 2 });
  assert.equal(captureAll.ok, true);
  if (!captureAll.ok) return;
  assert.equal(captureAll.game.winner, 'lower');
  assert.equal(captureAll.game.finishReason, 'capture-all');

  const stalematePieces = [
    piece('corner-cat', 'upper', 'cat', 0, 8),
    piece('block-east', 'lower', 'elephant', 1, 8),
    piece('block-south', 'lower', 'elephant', 0, 7),
    piece('mover-rat', 'lower', 'rat', 2, 8),
  ];
  assert.equal(beastHasAnyLegalMove(stalematePieces, 'upper'), false);
  const stalemate = playBeastMove(createBeastGame(stalematePieces), 'mover-rat', { x: 2, y: 7 });
  assert.equal(stalemate.ok, true);
  if (!stalemate.ok) return;
  assert.equal(stalemate.game.winner, 'lower');
  assert.equal(stalemate.game.finishReason, 'stalemate');
});

test('threefold repetition, one-hundred halfmoves and capture reset are tracked completely', () => {
  const repeatStart = createBeastGame([
    piece('repeat-lower', 'lower', 'cat', 3, 3),
    piece('repeat-upper', 'upper', 'cat', 6, 8),
  ]);
  const targetPieces = repeatStart.pieces.map(item => item.id === 'repeat-lower'
    ? { ...item, x: 3, y: 4 }
    : { ...item });
  const expectedKey = beastPositionKey(targetPieces, 'upper');
  repeatStart.positionCounts[expectedKey] = 2;
  const repeated = playBeastMove(repeatStart, 'repeat-lower', { x: 3, y: 4 });
  assert.equal(repeated.ok, true);
  if (!repeated.ok) return;
  assert.equal(repeated.game.status, 'finished');
  assert.equal(repeated.game.drawReason, 'threefold');
  assert.equal(repeated.game.positionCounts[expectedKey], 3);

  const halfmoveStart = {
    ...createBeastGame([
      piece('halfmove-lower', 'lower', 'cat', 3, 3),
      piece('halfmove-upper', 'upper', 'cat', 6, 8),
    ]),
    noCaptureHalfMoves: 99,
  };
  const halfmove = playBeastMove(halfmoveStart, 'halfmove-lower', { x: 3, y: 4 });
  assert.equal(halfmove.ok, true);
  if (!halfmove.ok) return;
  assert.equal(halfmove.game.status, 'finished');
  assert.equal(halfmove.game.drawReason, 'halfmove');
  assert.equal(halfmove.game.noCaptureHalfMoves, 100);

  const captureStart = {
    ...createBeastGame([
      piece('capture-reset-lion', 'lower', 'lion', 2, 2),
      piece('capture-reset-dog', 'upper', 'dog', 3, 2),
      safeUpper,
    ]),
    noCaptureHalfMoves: 99,
  };
  const capture = playBeastMove(captureStart, 'capture-reset-lion', { x: 3, y: 2 });
  assert.equal(capture.ok, true);
  if (!capture.ok) return;
  assert.equal(capture.game.status, 'playing');
  assert.equal(capture.game.noCaptureHalfMoves, 0);
});

test('undo restores board, turn, move history, repetition counts, halfmove counter and terminal state', () => {
  const start = {
    ...createBeastGame([
      piece('undo-lower', 'lower', 'cat', 3, 3),
      piece('undo-upper', 'upper', 'cat', 6, 8),
    ]),
    noCaptureHalfMoves: 99,
  };
  const before = structuredClone(start);
  const draw = playBeastMove(start, 'undo-lower', { x: 3, y: 4 });
  assert.equal(draw.ok, true);
  if (!draw.ok) return;
  assert.equal(draw.game.status, 'finished');
  const undone = undoBeastMove(draw.game);
  assert.deepEqual(undone, before);
  assert.equal(undoBeastMove(start), null);

  const finished = playBeastMove(createBeastGame([
    piece('undo-den-rat', 'lower', 'rat', 3, 7),
    safeUpper,
  ]), 'undo-den-rat', { x: 3, y: 8 });
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  const restored = undoBeastMove(finished.game)!;
  assert.equal(restored.status, 'playing');
  assert.equal(restored.winner, null);
  assert.equal(restored.finishReason, null);
  assert.equal(restored.pieces.some(item => item.id === 'undo-den-rat' && item.x === 3 && item.y === 7), true);
});

test('restart produces a clean canonical game without carrying history or counters', () => {
  const game = newBeastGame();
  const moved = playBeastMove(game, 'lower-tiger-0-0-0', { x: 1, y: 0 });
  assert.equal(moved.ok, true);
  const restarted = newBeastGame();
  assert.deepEqual(restarted, game);
  assert.equal(restarted.history.length, 0);
  assert.equal(restarted.noCaptureHalfMoves, 0);
  assert.equal(restarted.undoStates.length, 0);
});
