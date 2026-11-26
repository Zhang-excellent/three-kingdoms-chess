import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHINESE_INITIAL_FEN,
  chineseFenFromPieces,
  chineseMoveToUci,
  chinesePointToUci,
  chinesePositionCommand,
  chineseUciHistory,
  initialChineseFen,
  parseUciBestMove,
  uciPointToChinese,
} from '../src/chinese-chess-uci.ts';
import { newChineseGame, playChineseMove } from '../src/chinese-chess.ts';

test('Chinese chess UCI conversion preserves all 90 canonical points and the initial FEN', () => {
  assert.equal(initialChineseFen(), CHINESE_INITIAL_FEN);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const point = { x, y };
      assert.deepEqual(uciPointToChinese(chinesePointToUci(point)), point);
    }
  }
  assert.equal(chinesePointToUci({ x: 1, y: 7 }), 'b2');
  assert.equal(chinesePointToUci({ x: 4, y: 0 }), 'e9');
  assert.equal(chinesePointToUci({ x: 4, y: 9 }), 'e0');
  assert.equal(chineseFenFromPieces(newChineseGame().pieces), CHINESE_INITIAL_FEN);
});

test('Chinese chess UCI moves and history map without depending on board orientation', () => {
  const initial = newChineseGame();
  const moved = playChineseMove(initial, 'red-cannon-1-7', { x: 1, y: 6 });
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.equal(chineseMoveToUci(moved.game.history[0]), 'b2b3');
  assert.deepEqual(chineseUciHistory(moved.game), ['b2b3']);
  assert.equal(chinesePositionCommand(CHINESE_INITIAL_FEN, ['b2b3']),
    `position fen ${CHINESE_INITIAL_FEN} moves b2b3`);
  assert.deepEqual(parseUciBestMove('h2e2 ponder c0c1'), {
    from: { x: 7, y: 7 },
    to: { x: 4, y: 7 },
  });
  assert.equal(parseUciBestMove('(none)'), null);
});

test('Chinese chess UCI conversion rejects invalid files, ranks and malformed moves', () => {
  assert.throws(() => uciPointToChinese('j1'), /无效/);
  assert.throws(() => uciPointToChinese('a:'), /无效/);
  assert.throws(() => chinesePointToUci({ x: -1, y: 0 }), /超出/);
  assert.throws(() => chinesePointToUci({ x: 9, y: 0 }), /超出/);
  assert.throws(() => chineseMoveToUci({ from: { x: 0, y: 10 }, to: { x: 1, y: 1 } }), /超出/);
});
