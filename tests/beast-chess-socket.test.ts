import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import type { BeastAck, BeastReceipt, BeastState } from '../src/beast-chess.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
const sockets: Socket[] = [];
let origin = '';

before(async () => {
  await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  server.beast.dispose();
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

const emit = <T>(socket: Socket, event: string, payload: unknown): Promise<BeastAck<T>> =>
  new Promise(resolve => socket.emit(event, payload, resolve));

function success<T>(ack: BeastAck<T>): T {
  if (!ack.ok) throw new Error(`${ack.code}: ${ack.error}`);
  return ack.data;
}

test('two clients join, ready, move and leave one authoritative beast chess room', async () => {
  const malformed = await client();
  malformed.emit('beast:join', null);
  malformed.emit('beast:ready', null);
  malformed.emit('beast:move', null);
  assert.equal(success(await emit<BeastState>(malformed, 'beast:watch', {})).gameId, 'beast-chess');

  const registered = await server.authService.register('斗兽棋账号', '1234', false, '127.0.0.1');
  if (!registered.ok || !registered.sessionToken) assert.fail(JSON.stringify(registered));
  const [accountSocket, guestSocket, observer] = await Promise.all([
    client(`three_chess_session=${registered.sessionToken}`),
    client(),
    client(),
  ]);
  const accountStates: BeastState[] = [];
  const observerStates: BeastState[] = [];
  accountSocket.on('beast:state', state => accountStates.push(state));
  observer.on('beast:state', state => observerStates.push(state));
  success(await emit<BeastState>(observer, 'beast:watch', {}));

  const lower = success(await emit<BeastReceipt>(accountSocket, 'beast:join', { nickname: '', side: 'red' }));
  assert.equal(lower.state.players[0].nickname, '斗兽棋账号');
  const upper = success(await emit<BeastReceipt>(guestSocket, 'beast:join', {
    nickname: '斗兽棋游客',
    side: 'black',
  }));
  success(await emit(accountSocket, 'beast:ready', { reconnectToken: lower.reconnectToken, ready: true }));
  const started = success(await emit<{ state: BeastState }>(guestSocket, 'beast:ready', {
    reconnectToken: upper.reconnectToken,
    ready: true,
  })).state;
  assert.equal(started.game?.pieces.length, 16);
  assert.equal(started.game?.turn, 'lower');

  success(await emit(accountSocket, 'beast:move', {
    reconnectToken: lower.reconnectToken,
    intent: {
      requestId: 'beast-socket-1',
      version: started.version,
      pieceId: 'lower-tiger-0-0-0',
      to: { x: 1, y: 0 },
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(accountStates.at(-1)?.game?.turn, 'upper');
  assert.equal(accountStates.at(-1)?.game?.history.length, 1);

  accountSocket.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(observerStates.at(-1)?.players.map(player => [player.side, player.online]), [['red', false], ['black', true]]);
  assert.equal(observerStates.at(-1)?.phase, 'playing');
  assert.equal(observerStates.at(-1)?.game?.winner, null);

  const resumedSocket = await client(`three_chess_session=${registered.sessionToken}`);
  const resumed = success(await emit<BeastReceipt>(resumedSocket, 'beast:resume', {
    reconnectToken: lower.reconnectToken,
  }));
  assert.equal(resumed.state.phase, 'playing');
  assert.equal(resumed.state.game?.pieces.length, 16);
});
