import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChineseChessService } from '../server/chinese-chess-service.ts';

test('Chinese chess room requires a guest nickname and unique sides', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    const missing = service.join('', 'red', 'red');
    assert.equal(missing.ok, false);
    if (missing.ack.ok) return;
    assert.equal(missing.ack.code, 'NICKNAME_REQUIRED');
    assert.equal(service.join('红方', 'red', 'red').ok, true);
    const conflict = service.join('另一红方', 'red', 'other');
    assert.equal(conflict.ok, false);
    if (conflict.ack.ok) return;
    assert.equal(conflict.ack.code, 'SIDE_TAKEN');
  } finally { service.dispose(); }
});

test('both ready starts classic Chinese chess and enforces the current turn', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    const red = service.join('中国红', 'red', 'red');
    const black = service.join('中国黑', 'black', 'black');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.setReady(red.ack.data.reconnectToken, true, 'red');
    const started = service.setReady(black.ack.data.reconnectToken, true, 'black');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.game?.pieces.length, 32);
    const wrong = service.move(black.ack.data.reconnectToken, {
      requestId: 'chinese-wrong-1', version: started.ack.data.state.version,
      pieceId: 'black-pawn-0-3', to: { x: 0, y: 4 },
    }, 'black');
    assert.equal(wrong.ok, false);
    if (wrong.ack.ok) return;
    assert.equal(wrong.ack.code, 'NOT_YOUR_TURN');
    const moved = service.move(red.ack.data.reconnectToken, {
      requestId: 'chinese-red-1', version: started.ack.data.state.version,
      pieceId: 'red-pawn-0-6', to: { x: 0, y: 5 },
    }, 'red');
    assert.equal(moved.ok, true);
    if (!moved.ack.ok) return;
    assert.equal(moved.ack.data.state.game?.turn, 'black');
    assert.equal(moved.ack.data.state.game?.history.length, 1);
  } finally { service.dispose(); }
});

test('seat claims are atomic, a single ready player waits, and rematch keeps both sides', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    const red = service.join('座位红', 'red', 'red-a');
    const competing = service.join('抢座红', 'red', 'red-b');
    assert.equal(red.ok, true);
    assert.equal(competing.ok, false);
    if (competing.ack.ok) return;
    assert.equal(competing.ack.code, 'SIDE_TAKEN');
    const afterCompetingClaim = service.inspect();
    if (!afterCompetingClaim.ok) assert.fail('inspect failed');
    assert.equal(afterCompetingClaim.data.players.length, 1);
    if (!red.ack.ok) return;

    const readyAlone = service.setReady(red.ack.data.reconnectToken, true, 'red-a');
    assert.equal(readyAlone.ok, true);
    if (!readyAlone.ack.ok) return;
    assert.equal(readyAlone.ack.data.state.phase, 'lobby');
    assert.equal(readyAlone.ack.data.state.game, null);

    const black = service.join('座位黑', 'black', 'black');
    if (!black.ok || !black.ack.ok) assert.fail('black join failed');
    const oneReadyAck = service.inspect();
    if (!oneReadyAck.ok) assert.fail('inspect failed');
    const oneReady = oneReadyAck.data;
    assert.equal(oneReady.phase, 'lobby');
    assert.equal(oneReady.game, null);
    assert.deepEqual(oneReady.players.map(player => [player.side, player.ready]), [['red', true], ['black', false]]);

    const started = service.setReady(black.ack.data.reconnectToken, true, 'black');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.phase, 'playing');
    assert.equal(started.ack.data.state.game?.pieces.length, 32);

    const resigned = service.resign(red.ack.data.reconnectToken, 'red-a');
    assert.equal(resigned.ok, true);
    if (!resigned.ack.ok) return;
    assert.equal(resigned.ack.data.state.phase, 'finished');
    assert.equal(resigned.ack.data.state.game?.winner, 'black');

    const rematch = service.rematch(black.ack.data.reconnectToken, 'black');
    assert.equal(rematch.ok, true);
    if (!rematch.ack.ok) return;
    assert.equal(rematch.ack.data.state.phase, 'lobby');
    assert.equal(rematch.ack.data.state.round, 2);
    assert.equal(rematch.ack.data.state.game, null);
    assert.deepEqual(rematch.ack.data.state.players.map(player => [player.nickname, player.side, player.ready]), [
      ['座位红', 'red', false],
      ['座位黑', 'black', false],
    ]);
  } finally { service.dispose(); }
});

test('leaving Chinese chess immediately releases the seat and invalidates its credential', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    service.watch('observer');
    const red = service.join('离席红', 'red', 'red');
    if (!red.ok || !red.ack.ok) assert.fail('join failed');
    service.disconnect('red');
    const state = service.views().find(item => item.socketId === 'observer')?.state;
    assert.deepEqual(state?.players, []);
    const resumed = service.resume(red.ack.data.reconnectToken, 'red-new');
    assert.equal(resumed.ok, false);
  } finally { service.dispose(); }
});

test('authenticated Chinese chess identity uses the account nickname', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    service.setSocketAccount('account-a', 'user-a');
    service.setSocketAccount('account-b', 'user-b');
    const joined = service.join('账号象棋', 'red', 'account-a');
    assert.equal(joined.ok, true);
    if (!joined.ack.ok) return;
    assert.equal(joined.ack.data.state.players[0].identity, 'account');
    assert.equal(service.resume(joined.ack.data.reconnectToken, 'account-b').ok, false);
  } finally { service.dispose(); }
});
