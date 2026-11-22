import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeastChessService } from '../server/beast-chess-service.ts';

test('beast chess room requires a guest nickname and unique seats', () => {
  const service = new BeastChessService(() => undefined);
  try {
    const missing = service.join('', 'red', 'red');
    assert.equal(missing.ok, false);
    if (missing.ack.ok) return;
    assert.equal(missing.ack.code, 'NICKNAME_REQUIRED');
    assert.equal(service.join('下方游客', 'red', 'red').ok, true);
    const conflict = service.join('另一游客', 'red', 'other');
    assert.equal(conflict.ok, false);
    if (conflict.ack.ok) return;
    assert.equal(conflict.ack.code, 'SIDE_TAKEN');
  } finally {
    service.dispose();
  }
});

test('both ready starts beast chess and only the active seat may move', () => {
  const service = new BeastChessService(() => undefined);
  try {
    const lower = service.join('斗兽下方', 'red', 'red');
    const upper = service.join('斗兽上方', 'black', 'black');
    if (!lower.ok || !lower.ack.ok || !upper.ok || !upper.ack.ok) assert.fail('join failed');
    service.setReady(lower.ack.data.reconnectToken, true, 'red');
    const started = service.setReady(upper.ack.data.reconnectToken, true, 'black');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.phase, 'playing');
    assert.equal(started.ack.data.state.game?.pieces.length, 16);
    assert.equal(started.ack.data.state.game?.turn, 'lower');

    const wrong = service.move(upper.ack.data.reconnectToken, {
      requestId: 'beast-wrong-1',
      version: started.ack.data.state.version,
      pieceId: 'upper-lion-0-8-8',
      to: { x: 1, y: 8 },
    }, 'black');
    assert.equal(wrong.ok, false);
    if (wrong.ack.ok) return;
    assert.equal(wrong.ack.code, 'NOT_YOUR_TURN');

    const moved = service.move(lower.ack.data.reconnectToken, {
      requestId: 'beast-lower-1',
      version: started.ack.data.state.version,
      pieceId: 'lower-tiger-0-0-0',
      to: { x: 1, y: 0 },
    }, 'red');
    assert.equal(moved.ok, true);
    if (!moved.ack.ok) return;
    assert.equal(moved.ack.data.state.game?.turn, 'upper');
    assert.equal(moved.ack.data.state.game?.history.length, 1);
    assert.deepEqual(moved.ack.data.state.game?.undoStates, []);
  } finally {
    service.dispose();
  }
});

test('seat claims are atomic, one ready player waits, and rematch keeps both seats', () => {
  const service = new BeastChessService(() => undefined);
  try {
    const lower = service.join('抢座下方', 'red', 'red-a');
    const competing = service.join('抢座另一方', 'red', 'red-b');
    assert.equal(lower.ok, true);
    assert.equal(competing.ok, false);
    if (competing.ack.ok) return;
    assert.equal(competing.ack.code, 'SIDE_TAKEN');
    if (!lower.ack.ok) return;

    const readyAlone = service.setReady(lower.ack.data.reconnectToken, true, 'red-a');
    assert.equal(readyAlone.ok, true);
    if (!readyAlone.ack.ok) return;
    assert.equal(readyAlone.ack.data.state.phase, 'lobby');
    assert.equal(readyAlone.ack.data.state.game, null);

    const upper = service.join('抢座上方', 'black', 'black');
    if (!upper.ok || !upper.ack.ok) assert.fail('upper join failed');
    const started = service.setReady(upper.ack.data.reconnectToken, true, 'black');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.phase, 'playing');

    const resigned = service.resign(lower.ack.data.reconnectToken, 'red-a');
    assert.equal(resigned.ok, true);
    if (!resigned.ack.ok) return;
    assert.equal(resigned.ack.data.state.phase, 'finished');
    assert.equal(resigned.ack.data.state.game?.winner, 'upper');
    assert.equal(resigned.ack.data.state.game?.finishReason, 'resignation');

    const rematch = service.rematch(upper.ack.data.reconnectToken, 'black');
    assert.equal(rematch.ok, true);
    if (!rematch.ack.ok) return;
    assert.equal(rematch.ack.data.state.phase, 'lobby');
    assert.equal(rematch.ack.data.state.round, 2);
    assert.deepEqual(rematch.ack.data.state.players.map(player => [player.side, player.ready]), [
      ['red', false],
      ['black', false],
    ]);
  } finally {
    service.dispose();
  }
});

test('beast chess players can agree to a draw and leaving releases the seat', () => {
  const service = new BeastChessService(() => undefined);
  try {
    service.watch('observer');
    const lower = service.join('和棋下方', 'red', 'red');
    const upper = service.join('和棋上方', 'black', 'black');
    if (!lower.ok || !lower.ack.ok || !upper.ok || !upper.ack.ok) assert.fail('join failed');
    service.setReady(lower.ack.data.reconnectToken, true, 'red');
    service.setReady(upper.ack.data.reconnectToken, true, 'black');
    const offered = service.offerDraw(lower.ack.data.reconnectToken, 'red');
    assert.equal(offered.ok, true);
    if (!offered.ack.ok) return;
    assert.equal(offered.ack.data.state.drawOfferBy, 'red');
    const accepted = service.respondDraw(upper.ack.data.reconnectToken, true, 'black');
    assert.equal(accepted.ok, true);
    if (!accepted.ack.ok) return;
    assert.equal(accepted.ack.data.state.phase, 'finished');
    assert.equal(accepted.ack.data.state.game?.winner, null);
    assert.equal(accepted.ack.data.state.game?.drawReason, 'agreement');

    service.rematch(upper.ack.data.reconnectToken, 'black');
    service.disconnect('red');
    const observed = service.views().find(item => item.socketId === 'observer')?.state;
    assert.deepEqual(observed?.players.map(player => player.side), ['red', 'black']);
    const resumed = service.resume(lower.ack.data.reconnectToken, 'red-new');
    assert.equal(resumed.ok, true);
  } finally {
    service.dispose();
  }
});

test('beast chess disconnect expires after the grace period and forfeits an active game', async () => {
  const service = new BeastChessService(() => undefined, 30);
  try {
    const lower = service.join('超时下方', 'red', 'red');
    const upper = service.join('超时上方', 'black', 'black');
    if (!lower.ok || !lower.ack.ok || !upper.ok || !upper.ack.ok) assert.fail('join failed');
    service.disconnect('red');
    const waiting = service.inspect();
    if (!waiting.ok) assert.fail('inspect failed');
    assert.equal(waiting.data.phase, 'lobby');
    assert.deepEqual(waiting.data.players.map(player => [player.side, player.online]), [['red', false], ['black', true]]);
    const lobbyResume = service.resume(lower.ack.data.reconnectToken, 'red-waiting-new');
    assert.equal(lobbyResume.ok, true);

    service.setReady(lower.ack.data.reconnectToken, true, 'red-waiting-new');
    service.setReady(upper.ack.data.reconnectToken, true, 'black');
    service.disconnect('red-waiting-new');
    await new Promise(resolve => setTimeout(resolve, 60));
    const expired = service.inspect();
    if (!expired.ok) assert.fail('inspect failed');
    assert.deepEqual(expired.data.players.map(player => player.side), ['black']);
    assert.equal(expired.data.phase, 'finished');
    assert.equal(expired.data.game?.winner, 'upper');
  } finally {
    service.dispose();
  }
});

test('authenticated beast chess identity uses the account nickname and avatar', () => {
  const service = new BeastChessService(() => undefined);
  try {
    service.setSocketAccount('account-a', 'user-a', '/three-chess/api/avatar/user-a?v=1');
    service.setSocketAccount('account-b', 'user-b');
    const joined = service.join('账号昵称', 'red', 'account-a');
    assert.equal(joined.ok, true);
    if (!joined.ack.ok) return;
    assert.equal(joined.ack.data.state.players[0].identity, 'account');
    assert.equal(joined.ack.data.state.players[0].avatar, '/three-chess/api/avatar/user-a?v=1');
    assert.equal(service.resume(joined.ack.data.reconnectToken, 'account-b').ok, false);
  } finally {
    service.dispose();
  }
});
