import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHINESE_CHESS_GAME_ID,
  newChineseGame,
  playChineseMove,
  resignChineseGame,
} from '../src/chinese-chess.ts';
import { replayArchivedChineseGame } from '../src/chinese-game-history.ts';
import type { ArchivedChineseGameRecord } from '../src/chinese-game-history.ts';
import { AuthService } from '../server/auth-service.ts';

test('Chinese chess archives replay every move and preserve resignation endings', () => {
  const initial = newChineseGame();
  const first = playChineseMove(initial, 'red-pawn-0-6', { x: 0, y: 5 });
  if (!first.ok) assert.fail(first.error);
  const second = playChineseMove(first.game, 'black-pawn-0-3', { x: 0, y: 4 });
  if (!second.ok) assert.fail(second.error);
  const finalGame = resignChineseGame(second.game, 'red');
  const record: ArchivedChineseGameRecord = {
    gameType: 'chinese-chess',
    id: 'history-1',
    roomCode: CHINESE_CHESS_GAME_ID,
    round: 1,
    startedAt: 1,
    endedAt: 2,
    rulesVersion: initial.rulesVersion,
    initialGame: initial,
    participants: [
      { playerId: 'a', userId: 'user-a', nickname: '红', side: 'red', result: 'lost' },
      { playerId: 'b', userId: 'user-b', nickname: '黑', side: 'black', result: 'won' },
    ],
    moves: finalGame.history,
    events: [{ type: 'end', step: 2, reason: 'resignation', side: 'red', winner: 'black' }],
    finalGame,
    endReason: 'resignation',
    moveCount: 2,
    winner: 'black',
  };
  const replay = replayArchivedChineseGame(record);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.replay.frames.length, 3);
  assert.equal(replay.replay.frames[1].lastMove?.side, 'red');
  assert.equal(replay.replay.frames[2].lastMove?.side, 'black');
  assert.equal(replay.replay.frames[2].status, 'finished');
  assert.equal(replay.replay.frames[2].winner, 'black');
});

test('Chinese chess replay rejects a moved final position that disagrees with the history', () => {
  const initial = newChineseGame();
  const moved = playChineseMove(initial, 'red-pawn-0-6', { x: 0, y: 5 });
  if (!moved.ok) assert.fail(moved.error);
  const record: ArchivedChineseGameRecord = {
    gameType: 'chinese-chess',
    id: 'history-2',
    roomCode: CHINESE_CHESS_GAME_ID,
    round: 1,
    startedAt: 1,
    endedAt: 2,
    rulesVersion: initial.rulesVersion,
    initialGame: initial,
    participants: [],
    moves: moved.game.history,
    events: [{ type: 'end', step: 1, reason: 'resignation', winner: 'black' }],
    finalGame: { ...resignChineseGame(moved.game, 'red'), pieces: initial.pieces },
    endReason: 'resignation',
    moveCount: 1,
    winner: 'black',
  };
  const replay = replayArchivedChineseGame(record);
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.error, /最终盘面/);
});

test('Chinese chess account history keeps the newest five games and rejects third-party access', async () => {
  const auth = new AuthService(':memory:');
  try {
    const owner = await auth.register('中国棋谱主人', '1234', true, '127.0.0.1');
    const thirdParty = await auth.register('中国棋谱旁观', '1234', true, '127.0.0.1');
    if (!owner.ok || !owner.user || !thirdParty.ok || !thirdParty.user) assert.fail('account setup failed');
    for (let index = 1; index <= 6; index++) {
      const initial = newChineseGame();
      const finalGame = resignChineseGame(initial, 'red');
      auth.saveCompletedChineseGame({
        gameType: 'chinese-chess',
        id: `recent-${index}`,
        roomCode: CHINESE_CHESS_GAME_ID,
        round: index,
        startedAt: index * 10,
        endedAt: index * 10 + 1,
        rulesVersion: initial.rulesVersion,
        initialGame: initial,
        participants: [
          { playerId: `owner-${index}`, userId: owner.user.id, nickname: '中国棋谱主人', side: 'red', result: 'lost' },
          { playerId: `guest-${index}`, userId: null, nickname: '游客黑', side: 'black', result: 'won' },
        ],
        moves: [],
        events: [{ type: 'end', step: 0, reason: 'resignation', side: 'red', winner: 'black' }],
        finalGame,
        endReason: 'resignation',
        moveCount: 0,
        winner: 'black',
      });
    }
    assert.deepEqual(auth.recentChineseGames(owner.user.id, 5).map(game => game.id),
      ['recent-6', 'recent-5', 'recent-4', 'recent-3', 'recent-2']);
    assert.ok(auth.chineseGameForUser(owner.user.id, 'recent-6'));
    assert.equal(auth.chineseGameForUser(thirdParty.user.id, 'recent-6'), null);
  } finally {
    auth.close();
  }
});
