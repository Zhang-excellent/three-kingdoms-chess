import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import type { FiveAck, FiveReceipt, FiveState } from '../src/five-soldiers.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
const sockets: Socket[] = [];
let origin = '';

before(async () => {
  await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  server.five.dispose();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
  server.authService.close();
});

async function client(cookie?: string): Promise<Socket> {
  const socket = connect(origin, {
    path: '/three-chess/socket.io',
    forceNew: true,
    reconnection: false,
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function emit<T>(socket: Socket, event: string, payload: unknown): Promise<FiveAck<T>> {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}

function success<T>(ack: FiveAck<T>): T {
  if (!ack.ok) throw new Error(`${ack.code}: ${ack.error}`);
  return ack.data;
}

test('two independent sockets join, ready, play and receive the same authoritative five-soldiers state', async () => {
  const registered = await server.authService.register('五兵账号', '1234', false, '127.0.0.1');
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok || !registered.sessionToken) assert.fail('account registration failed');
  const cookie = `three_chess_session=${registered.sessionToken}`;
  const [accountSocket, guestSocket, observer] = await Promise.all([client(cookie), client(), client()]);
  const accountStates: FiveState[] = [], guestStates: FiveState[] = [];
  const observerStates: FiveState[] = [];
  accountSocket.on('five:state', state => accountStates.push(state));
  guestSocket.on('five:state', state => guestStates.push(state));
  observer.on('five:state', state => observerStates.push(state));

  const inspected = success(await emit<FiveState>(observer, 'five:watch', {}));
  assert.equal(inspected.phase, 'lobby');
  assert.equal(inspected.selfId, null);

  observer.emit('five:join', null);
  await new Promise(resolve => setTimeout(resolve, 20));
  const missingNickname = await emit<FiveReceipt>(observer, 'five:join', { nickname: '', side: 'black' });
  assert.equal(missingNickname.ok, false);
  if (missingNickname.ok) return;
  assert.equal(missingNickname.code, 'NICKNAME_REQUIRED');

  const red = success(await emit<FiveReceipt>(accountSocket, 'five:join', { nickname: '', side: 'red' }));
  assert.equal(red.state.players.find(player => player.id === red.playerId)?.nickname, '五兵账号');
  assert.equal(red.state.players.find(player => player.id === red.playerId)?.identity, 'account');
  const black = success(await emit<FiveReceipt>(guestSocket, 'five:join', { nickname: '五兵游客', side: 'black' }));

  success(await emit(accountSocket, 'five:ready', { reconnectToken: red.reconnectToken, ready: true }));
  const started = success(await emit<{ state: FiveState }>(guestSocket, 'five:ready', {
    reconnectToken: black.reconnectToken, ready: true,
  })).state;
  assert.equal(started.phase, 'playing');
  assert.equal(started.game?.pieces.filter(piece => piece.side === 'red').length, 10);
  assert.equal(started.game?.pieces.filter(piece => piece.side === 'black').length, 16);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(accountStates.at(-1)?.phase, 'playing');
  assert.equal(guestStates.at(-1)?.phase, 'playing');

  success(await emit(accountSocket, 'five:move', {
    reconnectToken: red.reconnectToken,
    intent: {
      requestId: 'five-socket-move-1',
      version: started.version,
      pieceId: 'red-pawn-0-6',
      to: { x: 0, y: 5 },
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual([accountStates.at(-1)?.game?.history.length, guestStates.at(-1)?.game?.history.length], [1, 1]);
  assert.equal(accountStates.at(-1)?.game?.turn, 'red');
  assert.equal(accountStates.at(-1)?.game?.movesRemaining, 1);
  assert.equal(guestStates.at(-1)?.game?.pieces.length, 26);

  const secondVersion = accountStates.at(-1)!.version;
  success(await emit(accountSocket, 'five:move', {
    reconnectToken: red.reconnectToken,
    intent: {
      requestId: 'five-socket-move-2',
      version: secondVersion,
      pieceId: 'red-pawn-2-6',
      to: { x: 2, y: 5 },
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(accountStates.at(-1)?.game?.turn, 'black');
  assert.equal(accountStates.at(-1)?.game?.movesRemaining, 1);
  assert.equal(guestStates.at(-1)?.game?.history.length, 2);

  accountSocket.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(observerStates.at(-1)?.players.map(player => [player.side, player.online]), [['red', false], ['black', true]]);
  assert.equal(observerStates.at(-1)?.phase, 'playing');
  assert.equal(observerStates.at(-1)?.game?.winner, null);

  const resumedSocket = await client(`three_chess_session=${registered.sessionToken}`);
  const resumed = success(await emit<FiveReceipt>(resumedSocket, 'five:resume', {
    reconnectToken: red.reconnectToken,
  }));
  assert.equal(resumed.state.phase, 'playing');
  assert.equal(resumed.state.game?.pieces.length, 26);
});
