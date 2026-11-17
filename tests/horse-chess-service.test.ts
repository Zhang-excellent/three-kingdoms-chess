import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HorseChessService } from '../server/horse-chess-service.ts';

test('horse chess room requires a guest nickname and unique sides', () => {
  const service = new HorseChessService(() => undefined);
  try {
    const missing = service.join('', 'red', 'red-socket');
    assert.equal(missing.ok, false);
    if (missing.ack.ok) return;
    assert.equal(missing.ack.code, 'NICKNAME_REQUIRED');
    const red = service.join('红方游客', 'red', 'red-socket');
    assert.equal(red.ok, true);
    if (!red.ack.ok) return;
    const conflict = service.join('另一红方', 'red', 'other-socket');
    assert.equal(conflict.ok, false);
    if (conflict.ack.ok) return;
    assert.equal(conflict.ack.code, 'SIDE_TAKEN');
  } finally { service.dispose(); }
});

test('both ready starts horse chess and only the current side may move', () => {
  const service = new HorseChessService(() => undefined);
  try {
    const red = service.join('马棋红', 'red', 'red-socket');
    const black = service.join('马棋黑', 'black', 'black-socket');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.setReady(red.ack.data.reconnectToken, true, 'red-socket');
    const started = service.setReady(black.ack.data.reconnectToken, true, 'black-socket');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.phase, 'playing');
    assert.equal(started.ack.data.state.game?.pieces.length, 18);
    const wrong = service.move(black.ack.data.reconnectToken, {
      requestId: 'horse-wrong-1', version: started.ack.data.state.version,
      pieceId: 'black-horse-0', to: { x: 2, y: 1 },
    }, 'black-socket');
    assert.equal(wrong.ok, false);
    if (wrong.ack.ok) return;
    assert.equal(wrong.ack.code, 'NOT_YOUR_TURN');
    const moved = service.move(red.ack.data.reconnectToken, {
      requestId: 'horse-red-1', version: started.ack.data.state.version,
      pieceId: 'red-horse-1', to: { x: 2, y: 7 },
    }, 'red-socket');
    assert.equal(moved.ok, true);
    if (!moved.ack.ok) return;
    assert.equal(moved.ack.data.state.game?.turn, 'black');
    assert.equal(moved.ack.data.state.game?.history.length, 1);
  } finally { service.dispose(); }
});

test('Horse Chess seat claims are atomic, one ready player waits, and rematch keeps both sides', () => {
  const service = new HorseChessService(() => undefined);
  try {
    const red = service.join('马棋座位红', 'red', 'red-a');
    const competing = service.join('马棋抢座红', 'red', 'red-b');
    assert.equal(red.ok, true);
    assert.equal(competing.ok, false);
    if (competing.ack.ok) return;
    assert.equal(competing.ack.code, 'SIDE_TAKEN');
    if (!red.ok || !red.ack.ok) return;

    const readyAlone = service.setReady(red.ack.data.reconnectToken, true, 'red-a');
    assert.equal(readyAlone.ok, true);
    if (!readyAlone.ack.ok) return;
    assert.equal(readyAlone.ack.data.state.phase, 'lobby');
    assert.equal(readyAlone.ack.data.state.game, null);

    const black = service.join('马棋座位黑', 'black', 'black');
    if (!black.ok || !black.ack.ok) assert.fail('black join failed');
    const oneReady = service.inspect();
    if (!oneReady.ok) assert.fail('inspect failed');
    assert.equal(oneReady.data.phase, 'lobby');
    assert.deepEqual(oneReady.data.players.map(player => [player.side, player.ready]), [['red', true], ['black', false]]);

    const started = service.setReady(black.ack.data.reconnectToken, true, 'black');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.phase, 'playing');
    assert.equal(started.ack.data.state.game?.pieces.length, 18);

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
      ['马棋座位红', 'red', false],
      ['马棋座位黑', 'black', false],
    ]);
  } finally { service.dispose(); }
});

test('leaving horse chess releases the seat immediately and notifies observers', () => {
  const service = new HorseChessService(() => undefined);
  try {
    service.watch('observer');
    const red = service.join('离席红', 'red', 'red-socket');
    if (!red.ok || !red.ack.ok) assert.fail('join failed');
    service.disconnect('red-socket');
    const state = service.views().find(item => item.socketId === 'observer')?.state;
    assert.deepEqual(state?.players, []);
    const resumed = service.resume(red.ack.data.reconnectToken, 'red-new');
    assert.equal(resumed.ok, false);
  } finally { service.dispose(); }
});

test('Horse Chess players can agree to a draw', () => {
  const service = new HorseChessService(() => undefined);
  try {
    const red = service.join('马棋和棋红', 'red', 'red');
    const black = service.join('马棋和棋黑', 'black', 'black');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.setReady(red.ack.data.reconnectToken, true, 'red');
    service.setReady(black.ack.data.reconnectToken, true, 'black');
    const offered = service.offerDraw(red.ack.data.reconnectToken, 'red');
    assert.equal(offered.ok, true);
    if (!offered.ack.ok) return;
    assert.equal(offered.ack.data.state.drawOfferBy, 'red');
    const accepted = service.respondDraw(black.ack.data.reconnectToken, true, 'black');
    assert.equal(accepted.ok, true);
    if (!accepted.ack.ok) return;
    assert.equal(accepted.ack.data.state.phase, 'finished');
    assert.equal(accepted.ack.data.state.game?.winner, null);
    assert.equal(accepted.ack.data.state.game?.endReason, 'draw');
  } finally { service.dispose(); }
});

test('authenticated horse chess identity uses the server account', () => {
  const service = new HorseChessService(() => undefined);
  try {
    service.setSocketAccount('account-a', 'user-a', '/three-chess/api/avatar/user-a?v=1');
    service.setSocketAccount('account-b', 'user-b');
    const joined = service.join('账号马棋', 'red', 'account-a');
    assert.equal(joined.ok, true);
    if (!joined.ack.ok) return;
    assert.equal(joined.ack.data.state.players[0].identity, 'account');
    assert.equal(joined.ack.data.state.players[0].avatar, '/three-chess/api/avatar/user-a?v=1');
    const mismatch = service.resume(joined.ack.data.reconnectToken, 'account-b');
    assert.equal(mismatch.ok, false);
  } finally { service.dispose(); }
});
