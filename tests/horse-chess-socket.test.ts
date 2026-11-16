import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import type { HorseAck, HorseReceipt, HorseState } from '../src/horse-chess.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
const sockets: Socket[] = [];
let origin = '';

before(async () => {
  await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  server.horse.dispose();
  server.five.dispose();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
  server.authService.close();
});

async function client(cookie?: string): Promise<Socket> {
  const socket = connect(origin, {
    path: '/three-chess/socket.io', forceNew: true, reconnection: false,
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve); socket.once('connect_error', reject);
  });
  return socket;
}

const emit = <T>(socket: Socket, event: string, payload: unknown): Promise<HorseAck<T>> =>
  new Promise(resolve => socket.emit(event, payload, resolve));
function success<T>(ack: HorseAck<T>): T {
  if (!ack.ok) throw new Error(`${ack.code}: ${ack.error}`);
  return ack.data;
}

test('two clients join, ready, move and leave one authoritative horse chess room', async () => {
  const registered = await server.authService.register('马棋账号', '1234', false, '127.0.0.1');
  if (!registered.ok || !registered.sessionToken) assert.fail(JSON.stringify(registered));
  const [accountSocket, guestSocket, observer] = await Promise.all([
    client(`three_chess_session=${registered.sessionToken}`), client(), client(),
  ]);
  const accountStates: HorseState[] = [], observerStates: HorseState[] = [];
  accountSocket.on('horse:state', state => accountStates.push(state));
  observer.on('horse:state', state => observerStates.push(state));
  const inspected = success(await emit<HorseState>(observer, 'horse:watch', {}));
  assert.equal(inspected.players.length, 0);
  const red = success(await emit<HorseReceipt>(accountSocket, 'horse:join', { nickname: '', side: 'red' }));
  assert.equal(red.state.players[0].nickname, '马棋账号');
  const black = success(await emit<HorseReceipt>(guestSocket, 'horse:join', { nickname: '马棋游客', side: 'black' }));
  success(await emit(accountSocket, 'horse:ready', { reconnectToken: red.reconnectToken, ready: true }));
  const started = success(await emit<{ state: HorseState }>(guestSocket, 'horse:ready', {
    reconnectToken: black.reconnectToken, ready: true,
  })).state;
  assert.equal(started.phase, 'playing');
  assert.equal(started.game?.pieces.length, 18);
  success(await emit(accountSocket, 'horse:move', {
    reconnectToken: red.reconnectToken,
    intent: {
      requestId: 'horse-socket-1', version: started.version,
      pieceId: 'red-horse-1', to: { x: 2, y: 7 },
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(accountStates.at(-1)?.game?.turn, 'black');
  assert.equal(accountStates.at(-1)?.game?.history.length, 1);
  accountSocket.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(observerStates.at(-1)?.players.map(player => player.side), ['black']);
  assert.equal(observerStates.at(-1)?.phase, 'finished');
  assert.equal(observerStates.at(-1)?.game?.winner, 'black');
});
