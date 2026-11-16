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

test('authenticated horse chess identity uses the server account', () => {
  const service = new HorseChessService(() => undefined);
  try {
    service.setSocketAccount('account-a', 'user-a');
    service.setSocketAccount('account-b', 'user-b');
    const joined = service.join('账号马棋', 'red', 'account-a');
    assert.equal(joined.ok, true);
    if (!joined.ack.ok) return;
    assert.equal(joined.ack.data.state.players[0].identity, 'account');
    const mismatch = service.resume(joined.ack.data.reconnectToken, 'account-b');
    assert.equal(mismatch.ok, false);
  } finally { service.dispose(); }
});
