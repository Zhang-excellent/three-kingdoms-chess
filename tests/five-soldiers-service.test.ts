import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiveSoldiersService } from '../server/five-soldiers-service.ts';

test('five soldiers room requires a guest nickname and keeps one seat per side', () => {
  const service = new FiveSoldiersService(() => undefined);
  try {
    const missing = service.join('', 'red', 'red-socket');
    assert.equal(missing.ok, false);
    assert.equal(missing.ack.ok, false);
    if (missing.ack.ok) return;
    assert.equal(missing.ack.code, 'NICKNAME_REQUIRED');

    const red = service.join('红方玩家', 'red', 'red-socket');
    assert.equal(red.ok, true);
    if (!red.ok || !red.ack.ok) return;
    const sameSide = service.join('另一个红方', 'red', 'other-socket');
    assert.equal(sameSide.ok, false);
    if (sameSide.ack.ok) return;
    assert.equal(sameSide.ack.code, 'SIDE_TAKEN');

    const black = service.join('黑方玩家', 'black', 'black-socket');
    assert.equal(black.ok, true);
    if (!black.ok || !black.ack.ok) return;
    assert.deepEqual(black.ack.data.state.players.map(player => [player.side, player.nickname]), [
      ['red', '红方玩家'], ['black', '黑方玩家'],
    ]);
  } finally { service.dispose(); }
});

test('both ready starts one authoritative game and rejects wrong-turn or stale moves', () => {
  const service = new FiveSoldiersService(() => undefined);
  try {
    const red = service.join('账号红', 'red', 'red-socket');
    const black = service.join('账号黑', 'black', 'black-socket');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    const redToken = red.ack.data.reconnectToken, blackToken = black.ack.data.reconnectToken;
    assert.equal(service.setReady(redToken, true, 'red-socket').ok, true);
    const started = service.setReady(blackToken, true, 'black-socket');
    assert.equal(started.ok, true);
    if (!started.ack.ok) assert.fail('start failed');
    assert.equal(started.ack.data.state.phase, 'playing');
    assert.equal(started.ack.data.state.game?.pieces.length, 26);

    const version = started.ack.data.state.version;
    const wrongTurn = service.move(blackToken, {
      requestId: 'five-wrong-turn', version, pieceId: 'black-horse-1-0', to: { x: 0, y: 2 },
    }, 'black-socket');
    assert.equal(wrongTurn.ok, false);
    if (wrongTurn.ack.ok) return;
    assert.equal(wrongTurn.ack.code, 'NOT_YOUR_TURN');

    const moved = service.move(redToken, {
      requestId: 'five-red-move-1', version, pieceId: 'red-pawn-0-6', to: { x: 0, y: 5 },
    }, 'red-socket');
    assert.equal(moved.ok, true);
    if (!moved.ack.ok) return;
    assert.equal(moved.ack.data.state.game?.turn, 'black');
    assert.equal(moved.ack.data.state.game?.history[0].pieceId, 'red-pawn-0-6');

    const stale = service.move(redToken, {
      requestId: 'five-stale-move', version, pieceId: 'red-pawn-2-6', to: { x: 2, y: 5 },
    }, 'red-socket');
    assert.equal(stale.ok, false);
    if (stale.ack.ok) return;
    assert.equal(stale.ack.code, 'STALE_VERSION');
  } finally { service.dispose(); }
});

test('five soldiers disconnect resume, resignation and rematch preserve room identity', () => {
  const service = new FiveSoldiersService(() => undefined);
  try {
    const red = service.join('重连红', 'red', 'red-old');
    const black = service.join('重连黑', 'black', 'black-socket');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.setReady(red.ack.data.reconnectToken, true, 'red-old');
    service.setReady(black.ack.data.reconnectToken, true, 'black-socket');

    service.disconnect('red-old');
    const resumed = service.resume(red.ack.data.reconnectToken, 'red-new');
    assert.equal(resumed.ok, true);
    if (!resumed.ack.ok) return;
    assert.equal(resumed.ack.data.state.players.find(player => player.side === 'red')?.online, true);

    const resigned = service.resign(red.ack.data.reconnectToken, 'red-new');
    assert.equal(resigned.ok, true);
    if (!resigned.ack.ok) return;
    assert.equal(resigned.ack.data.state.phase, 'finished');
    assert.equal(resigned.ack.data.state.game?.winner, 'black');

    const rematch = service.rematch(black.ack.data.reconnectToken, 'black-socket');
    assert.equal(rematch.ok, true);
    if (!rematch.ack.ok) return;
    assert.equal(rematch.ack.data.state.phase, 'lobby');
    assert.equal(rematch.ack.data.state.game, null);
    assert.equal(rematch.ack.data.state.players.every(player => !player.ready), true);
  } finally { service.dispose(); }
});

test('authenticated socket identity supplies the nickname and cannot resume as another account', () => {
  const service = new FiveSoldiersService(() => undefined);
  try {
    service.setSocketAccount('account-a', 'user-a');
    service.setSocketAccount('account-b', 'user-b');
    const joined = service.join('客户端伪造昵称', 'red', 'account-a');
    assert.equal(joined.ok, true);
    if (!joined.ack.ok) return;
    assert.equal(joined.ack.data.state.players[0].nickname, '客户端伪造昵称');
    assert.equal(joined.ack.data.state.players[0].identity, 'account');
    const mismatch = service.resume(joined.ack.data.reconnectToken, 'account-b');
    assert.equal(mismatch.ok, false);
    if (mismatch.ack.ok) return;
    assert.equal(mismatch.ack.code, 'AUTH_MISMATCH');
  } finally { service.dispose(); }
});
