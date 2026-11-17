import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import type { ChineseAck, ChineseReceipt, ChineseState } from '../src/chinese-chess.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
const sockets: Socket[] = [];
let origin = '';

before(async () => {
  await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  server.chinese.dispose();
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
const emit = <T>(socket: Socket, event: string, payload: unknown): Promise<ChineseAck<T>> =>
  new Promise(resolve => socket.emit(event, payload, resolve));
function success<T>(ack: ChineseAck<T>): T {
  if (!ack.ok) throw new Error(`${ack.code}: ${ack.error}`);
  return ack.data;
}

test('two clients start classic Chinese chess and receive one authoritative move', async () => {
  const malformed = await client();
  malformed.emit('chinese:join', null);
  malformed.emit('chinese:ready', null);
  malformed.emit('chinese:move', null);
  assert.equal(success(await emit<ChineseState>(malformed, 'chinese:watch', {})).gameId, 'chinese-chess');

  const registered = await server.authService.register('中国象棋账号', '1234', false, '127.0.0.1');
  if (!registered.ok || !registered.sessionToken) assert.fail(JSON.stringify(registered));
  const [accountSocket, guestSocket, observer] = await Promise.all([
    client(`three_chess_session=${registered.sessionToken}`), client(), client(),
  ]);
  const accountStates: ChineseState[] = [], observerStates: ChineseState[] = [];
  accountSocket.on('chinese:state', state => accountStates.push(state));
  observer.on('chinese:state', state => observerStates.push(state));
  success(await emit<ChineseState>(observer, 'chinese:watch', {}));
  const red = success(await emit<ChineseReceipt>(accountSocket, 'chinese:join', { nickname: '', side: 'red' }));
  assert.equal(red.state.players[0].nickname, '中国象棋账号');
  const black = success(await emit<ChineseReceipt>(guestSocket, 'chinese:join', { nickname: '象棋游客', side: 'black' }));
  success(await emit(accountSocket, 'chinese:ready', { reconnectToken: red.reconnectToken, ready: true }));
  const started = success(await emit<{ state: ChineseState }>(guestSocket, 'chinese:ready', {
    reconnectToken: black.reconnectToken, ready: true,
  })).state;
  assert.equal(started.game?.pieces.length, 32);
  success(await emit(accountSocket, 'chinese:move', {
    reconnectToken: red.reconnectToken,
    intent: {
      requestId: 'chinese-socket-1', version: started.version,
      pieceId: 'red-pawn-0-6', to: { x: 0, y: 5 },
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
