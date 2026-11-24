import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import type { MistAck, MistReceipt, MistState } from '../src/mist-chess.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
const sockets: Socket[] = [];
let origin = '';

before(async () => {
  await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  server.mist.dispose();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
  server.authService.close();
});

async function client(): Promise<Socket> {
  const socket = connect(origin, {
    path: '/three-chess/socket.io', forceNew: true, reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

const emit = <T>(socket: Socket, event: string, payload: unknown): Promise<MistAck<T>> =>
  new Promise(resolve => socket.emit(event, payload, resolve));

function success<T>(ack: MistAck<T>): T {
  if (!ack.ok) throw new Error(`${ack.code}: ${ack.error}`);
  return ack.data;
}

test('two mist chess clients receive only their own projected board and hidden opponent actions', async () => {
  const [redSocket, blackSocket, visitor] = await Promise.all([client(), client(), client()]);
  const redStates: MistState[] = [];
  const blackStates: MistState[] = [];
  redSocket.on('mist:state', state => redStates.push(state));
  blackSocket.on('mist:state', state => blackStates.push(state));

  const visitorState = success(await emit<MistState>(visitor, 'mist:inspect', {}));
  assert.equal(visitorState.game, null);
  const red = success(await emit<MistReceipt>(redSocket, 'mist:join', { nickname: '迷雾红游客', side: 'red' }));
  const black = success(await emit<MistReceipt>(blackSocket, 'mist:join', { nickname: '迷雾黑游客', side: 'black' }));
  assert.equal(red.state.game?.pieces.some(piece => piece.id === 'black-king-4-0'), false);
  assert.equal(black.state.game?.pieces.some(piece => piece.id === 'red-king-4-9'), false);
  success(await emit(redSocket, 'mist:ready', { reconnectToken: red.reconnectToken, ready: true }));
  const started = success(await emit<{ state: MistState }>(blackSocket, 'mist:ready', {
    reconnectToken: black.reconnectToken, ready: true,
  })).state;

  success(await emit(redSocket, 'mist:move', {
    reconnectToken: red.reconnectToken,
    intent: {
      requestId: 'mist-socket-red-1',
      version: started.version,
      pieceId: 'red-pawn-0-6',
      to: { x: 0, y: 5 },
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 30));
  const latestRed = redStates.at(-1);
  const latestBlack = blackStates.at(-1);
  assert.equal(latestRed?.game?.history.length, 1);
  assert.equal(latestRed?.game?.lastMove?.from.x, 0);
  assert.equal(latestBlack?.game?.history.length, 0);
  assert.equal(latestBlack?.game?.lastMove, null);
  assert.equal(latestBlack?.game?.pieces.some(piece => piece.id === 'red-king-4-9'), false);
  assert.equal(JSON.stringify(latestBlack).includes('red-pawn-0-6'), false);

  redSocket.disconnect();
  await new Promise(resolve => setTimeout(resolve, 30));
  const disconnected = success(await emit<MistState>(visitor, 'mist:inspect', {}));
  assert.equal(disconnected.game, null);
  assert.deepEqual(disconnected.players.map(player => [player.side, player.online]), [['red', false], ['black', true]]);

  const resumedSocket = await client();
  const resumed = success(await emit<MistReceipt>(resumedSocket, 'mist:resume', {
    reconnectToken: red.reconnectToken,
  }));
  assert.equal(resumed.state.phase, 'playing');
  assert.equal(resumed.state.game?.turn, 'black');
  assert.equal(resumed.state.game?.history.length, 1);
  assert.equal(resumed.state.game?.pieces.some(piece => piece.id === 'black-king-4-0'), false);
});
