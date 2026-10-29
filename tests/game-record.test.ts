import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawGame, newGame, playMove, resignFaction } from '../src/game.ts';
import { buildGameRecord, gameRecordFileName } from '../src/game-record.ts';

test('game record exports readable moves, versioned rules and both board states', () => {
  const moved = playMove(newGame(), 'wei-pawn-0-6', { x: 0, y: 5 });
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  const record = buildGameRecord(moved.game, new Date(2026, 9, 28, 23, 7, 9));
  assert.match(record, /^# 三国象棋棋谱/);
  assert.match(record, /规则版本：`independent-win-loss-draw-v1`/);
  assert.match(record, /导出时间：2026-10-28 23:07:09/);
  assert.match(record, /对局状态：对局进行中，轮到刘备/);
  assert.match(record, /1\. 曹操 · 兵 \(1, 7\) → \(1, 6\)/);
  assert.match(record, /## 初始子力[\s\S]*- 魏方（16 枚）：[\s\S]*- 蜀方（7 枚）：[\s\S]*- 吴方（6 枚）：/);
  assert.match(record, /## 导出时子力[\s\S]*魏方兵 \(1, 6\)/);
  assert.equal(gameRecordFileName(new Date(2026, 9, 28, 23, 7, 9)), '三国象棋棋谱-20261028-230709.md');
});

test('game record includes final results and empty armies after eliminations', () => {
  const first = resignFaction(newGame(), 'shu');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const finished = resignFaction(first.game, 'wu');
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  const record = buildGameRecord(finished.game);
  assert.match(record, /对局状态：曹操获胜/);
  assert.match(record, /曹操胜利；刘备失败；孙权失败/);
  assert.match(record, /- 蜀方（0 枚）：无/);
  assert.match(record, /- 吴方（0 枚）：无/);
});

test('game record labels unanimous draw results', () => {
  const result = drawGame(newGame());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = buildGameRecord(result.game);
  assert.match(record, /对局状态：和棋/);
  assert.match(record, /曹操和棋；刘备和棋；孙权和棋/);
});

test('game record rejects an invalid snapshot instead of exporting misleading data', () => {
  assert.throws(() => buildGameRecord({ ...newGame(), turn: null }), /无法导出无效棋局/);
});
