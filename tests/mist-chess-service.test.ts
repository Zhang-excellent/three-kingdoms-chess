import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MistChessService } from '../server/mist-chess-service.ts';

function joined() {
  const service = new MistChessService(() => undefined);
  const red = service.join('迷雾红', 'red', 'red');
  const black = service.join('迷雾黑', 'black', 'black');
  if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) throw new Error('join failed');
  return { service, red: red.ack.data, black: black.ack.data };
}

test('mist chess room seats two sides and exposes no board to an unseated visitor', () => {
  const { service, red, black } = joined();
  try {
    const inspected = service.inspect('visitor');
    if (!inspected.ok) assert.fail('inspect failed');
    assert.equal(inspected.data.players.length, 2);
    assert.equal(inspected.data.game, null);
    assert.equal(red.state.game?.pieces.some(piece => piece.id === 'black-king-4-0'), false);
    assert.equal(black.state.game?.pieces.some(piece => piece.id === 'red-king-4-9'), false);
  } finally { service.dispose(); }
});

test('both ready starts a server-authoritative game with separate views and hidden opponent actions', () => {
  const { service, red, black } = joined();
  try {
    service.setReady(red.reconnectToken, true, 'red');
    const started = service.setReady(black.reconnectToken, true, 'black');
    if (!started.ok || !started.ack.ok) assert.fail('game did not start');
    const version = started.ack.data.state.version;
    const moved = service.move(red.reconnectToken, {
      requestId: 'mist-service-red-1',
      version,
      pieceId: 'red-pawn-0-6',
      to: { x: 0, y: 5 },
    }, 'red');
    assert.equal(moved.ok, true);

    const views = service.views();
    const redState = views.find(item => item.socketId === 'red')?.state;
    const blackState = views.find(item => item.socketId === 'black')?.state;
    assert.equal(redState?.game?.turn, 'black');
    assert.equal(redState?.game?.history.length, 1);
    assert.equal(redState?.game?.lastMove?.from.x, 0);
    assert.equal(blackState?.game?.turn, 'black');
    assert.equal(blackState?.game?.history.length, 0);
    assert.equal(blackState?.game?.lastMove, null);
    assert.equal(blackState?.game?.moveCount, 1);
    assert.equal(blackState?.game?.pieces.some(piece => piece.id === 'red-king-4-9'), false);
    assert.equal(JSON.stringify(blackState).includes('red-pawn-0-6'), false);
  } finally { service.dispose(); }
});

test('rejected move errors stay generic and do not expose hidden blocking pieces', () => {
  const { service, red, black } = joined();
  try {
    service.setReady(red.reconnectToken, true, 'red');
    const started = service.setReady(black.reconnectToken, true, 'black');
    if (!started.ok || !started.ack.ok) assert.fail('game did not start');
    const result = service.move(red.reconnectToken, {
      requestId: 'mist-service-invalid-1',
      version: started.ack.data.state.version,
      pieceId: 'red-rook-0-9',
      to: { x: 0, y: 3 },
    }, 'red');
    assert.equal(result.ok, false);
    if (result.ack.ok) return;
    assert.equal(result.ack.code, 'ILLEGAL_MOVE');
    assert.match(result.ack.error, /无法执行/);
    assert.doesNotMatch(result.ack.error, /炮架|阻挡|将帅|棋子/);
  } finally { service.dispose(); }
});

test('resignation, rematch and account identity preserve the mist room lifecycle', () => {
  const service = new MistChessService(() => undefined);
  try {
    service.setSocketAccount('account-red', 'user-red', '/three-chess/api/avatar/user-red?v=1');
    service.setSocketAccount('account-black', 'user-black');
    const red = service.join('', 'red', 'account-red');
    const black = service.join('迷雾账号黑', 'black', 'account-black');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    assert.equal(red.ack.data.state.players[0].nickname, '账号玩家');
    assert.equal(red.ack.data.state.players[0].identity, 'account');
    assert.equal(red.ack.data.state.players[0].avatar, '/three-chess/api/avatar/user-red?v=1');
    service.setReady(red.ack.data.reconnectToken, true, 'account-red');
    service.setReady(black.ack.data.reconnectToken, true, 'account-black');
    const resigned = service.resign(red.ack.data.reconnectToken, 'account-red');
    assert.equal(resigned.ok, true);
    if (!resigned.ack.ok) return;
    assert.equal(resigned.ack.data.state.phase, 'finished');
    assert.equal(resigned.ack.data.state.game?.winner, 'black');
    assert.equal(resigned.ack.data.state.game?.fullBoardVisible, true);
    const rematch = service.rematch(black.ack.data.reconnectToken, 'account-black');
    assert.equal(rematch.ok, true);
    if (!rematch.ack.ok) return;
    assert.equal(rematch.ack.data.state.phase, 'lobby');
    assert.equal(rematch.ack.data.state.players.every(player => !player.ready), true);
  } finally { service.dispose(); }
});

test('mist room keeps a disconnected seat for the grace period and then forfeits once', async () => {
  const service = new MistChessService(() => undefined, 30);
  try {
    const red = service.join('断线红', 'red', 'red');
    const black = service.join('断线黑', 'black', 'black');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.setReady(red.ack.data.reconnectToken, true, 'red');
    service.setReady(black.ack.data.reconnectToken, true, 'black');
    service.disconnect('red');
    const waiting = service.views().find(item => item.socketId === 'black')?.state;
    assert.deepEqual(waiting?.players.map(player => [player.side, player.online]), [['red', false], ['black', true]]);
    const resumed = service.resume(red.ack.data.reconnectToken, 'red-new');
    assert.equal(resumed.ok, true);
    service.disconnect('red-new');
    await new Promise(resolve => setTimeout(resolve, 60));
    const expired = service.views().find(item => item.socketId === 'black')?.state;
    assert.deepEqual(expired?.players.map(player => player.side), ['black']);
    assert.equal(expired?.phase, 'finished');
    assert.equal(expired?.game?.winner, 'black');
  } finally { service.dispose(); }
});
