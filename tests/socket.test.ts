import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import { newGame } from '../src/game.ts';
import type { ClientAck, RoomView, SessionReceipt } from '../src/online.ts';

const server = createOnlineServer();
let origin = '';
const sockets: Socket[] = [];

before(async () => {
  await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
});

async function client(): Promise<Socket> {
  const socket = connect(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}

function emit<T>(socket: Socket, event: string, payload: unknown): Promise<ClientAck<T>> {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}

function success<T>(ack: ClientAck<T>): T {
  assert.equal(ack.ok, true); if (!ack.ok) assert.fail('socket action failed'); return ack.data;
}

const pause = () => new Promise(resolve => setTimeout(resolve, 30));

test('three independent Socket.IO clients create, join, start, move, and reconnect in sync', async () => {
  const [wei, shu, wu] = await Promise.all([client(), client(), client()]);
  const latest: Array<RoomView | null> = [null, null, null];
  [wei, shu, wu].forEach((socket, index) => socket.on('room:state', state => { latest[index] = state; }));
  const a = success(await emit<SessionReceipt>(wei, 'room:create', { nickname: '网络魏' }));
  const b = success(await emit<SessionReceipt>(shu, 'room:join', { nickname: '网络蜀', roomCode: a.roomCode }));
  const c = success(await emit<SessionReceipt>(wu, 'room:join', { nickname: '网络吴', roomCode: a.roomCode }));
  const sessions = [a, b, c], clients = [wei, shu, wu], factions = ['wei', 'shu', 'wu'];
  for (let index = 0; index < 3; index++) success(await emit(clients[index], 'room:choose-faction', {
    roomCode: a.roomCode, reconnectToken: sessions[index].reconnectToken, faction: factions[index],
  }));
  for (let index = 0; index < 3; index++) success(await emit(clients[index], 'room:ready', {
    roomCode: a.roomCode, reconnectToken: sessions[index].reconnectToken, ready: true,
  }));
  await pause();
  assert.equal(latest.every(state => state?.phase === 'playing' && state.game?.pieces.length === 29), true);
  const version = latest[0]!.version;
  success(await emit(wei, 'game:move', { roomCode: a.roomCode, reconnectToken: a.reconnectToken,
    intent: { requestId: 'socketmove01', version, pieceId: 'wei-pawn-0-6', to: { x: 0, y: 5 } } }));
  await pause();
  assert.deepEqual(latest.map(state => state?.game?.history.length), [1, 1, 1]);
  assert.deepEqual(latest.map(state => state?.game?.turn), ['shu', 'shu', 'shu']);
  shu.disconnect(); await pause();
  assert.equal(latest[0]?.players.find(player => player.id === b.playerId)?.online, false);
  const resumedClient = await client();
  resumedClient.on('room:state', state => { latest[1] = state; });
  const resumed = success(await emit<SessionReceipt>(resumedClient, 'room:resume', { roomCode: a.roomCode, reconnectToken: b.reconnectToken }));
  assert.equal(resumed.state.players.length, 3); assert.equal(resumed.state.game?.history.length, 1);
  assert.equal(resumed.state.players.find(player => player.id === b.playerId)?.online, true);
  // Put this room at a legal near-end position to verify the actual server broadcast and ranking protocol.
  const stored = server.rooms.getRoom(a.roomCode)!;
  const nearEnd = newGame();
  nearEnd.pieces = nearEnd.pieces.filter(piece => piece.kind === 'king');
  nearEnd.pieces.push({ id: 'shu-attacker', faction: 'shu', kind: 'rook', x: 4, y: 7 },
    { id: 'wu-attacker', faction: 'wu', kind: 'rook', x: 2, y: 1 });
  nearEnd.turn = 'shu'; nearEnd.turnSlot = 1;
  stored.game = nearEnd; stored.version++;
  success(await emit(resumedClient, 'game:move', { roomCode: a.roomCode, reconnectToken: b.reconnectToken,
    intent: { requestId: 'caoout0001', version: stored.version, pieceId: 'shu-attacker', to: { x: 4, y: 9 } } }));
  await pause();
  assert.equal(latest.every(state => state?.game?.status === 'playing' && state.game.placements.wei === 3 && state.game.turn === 'wu'), true);
  success(await emit(wu, 'game:move', { roomCode: a.roomCode, reconnectToken: c.reconnectToken,
    intent: { requestId: 'shuout0001', version: stored.version, pieceId: 'wu-attacker', to: { x: 2, y: 0 } } }));
  await pause();
  assert.equal(latest.every(state => state?.phase === 'finished' && state.game?.winner === 'wu'
    && state.game.placements.wei === 3 && state.game.placements.shu === 2 && state.game.placements.wu === 1), true);
});

test('socket lobby exit and manual offline release let newcomers join without leaking rooms', async () => {
  const [aSocket, bSocket, cSocket, dSocket] = await Promise.all([client(), client(), client(), client()]);
  const a = success(await emit<SessionReceipt>(aSocket, 'room:create', { nickname: 'A' }));
  const b = success(await emit<SessionReceipt>(bSocket, 'room:join', { roomCode: a.roomCode, nickname: 'B' }));
  const c = success(await emit<SessionReceipt>(cSocket, 'room:join', { roomCode: a.roomCode, nickname: 'C' }));
  const room = server.rooms.getRoom(a.roomCode)!;
  const full = await emit<SessionReceipt>(dSocket, 'room:join', { roomCode: a.roomCode, nickname: 'D' });
  assert.equal(full.ok, false);
  success(await emit(bSocket, 'room:choose-faction', { roomCode: a.roomCode, reconnectToken: b.reconnectToken, faction: 'shu' }));
  success(await emit(bSocket, 'room:ready', { roomCode: a.roomCode, reconnectToken: b.reconnectToken, ready: true }));
  bSocket.disconnect(); await pause();
  assert.equal(room.players.find(player => player.id === b.playerId)?.ready, false);
  assert.equal(room.players.find(player => player.id === b.playerId)?.online, false);
  const released = success(await emit<{ state: RoomView }>(aSocket, 'room:release-offline', {
    roomCode: a.roomCode, reconnectToken: a.reconnectToken, playerId: b.playerId,
  }));
  assert.equal(released.state.players.length, 2);
  const replacement = success(await emit<SessionReceipt>(dSocket, 'room:join', { roomCode: a.roomCode, nickname: 'D' }));
  assert.equal(replacement.roomCode, a.roomCode);
  const cannotKick = await emit(aSocket, 'room:release-offline', { roomCode: a.roomCode, reconnectToken: a.reconnectToken, playerId: replacement.playerId });
  assert.equal(cannotKick.ok, false);
  success(await emit(cSocket, 'room:leave', { roomCode: a.roomCode, reconnectToken: c.reconnectToken }));
  assert.equal(room.players.length, 2);
  success(await emit(dSocket, 'room:leave', { roomCode: a.roomCode, reconnectToken: replacement.reconnectToken }));
  success(await emit(aSocket, 'room:leave', { roomCode: a.roomCode, reconnectToken: a.reconnectToken }));
  assert.equal(server.rooms.getRoom(a.roomCode), undefined);
  const next = success(await emit<SessionReceipt>(aSocket, 'room:create', { nickname: 'A-again' }));
  assert.notEqual(next.roomCode, a.roomCode);
});

test('three sockets receive resignation and in-game exit; departed connection cannot move', async () => {
  const [wei, shu, wu] = await Promise.all([client(), client(), client()]);
  const a = success(await emit<SessionReceipt>(wei, 'room:create', { nickname: '魏' }));
  const b = success(await emit<SessionReceipt>(shu, 'room:join', { nickname: '蜀', roomCode: a.roomCode }));
  const c = success(await emit<SessionReceipt>(wu, 'room:join', { nickname: '吴', roomCode: a.roomCode }));
  const receipts = [a, b, c], sockets3 = [wei, shu, wu], factions = ['wei', 'shu', 'wu'];
  const latest: Array<RoomView | null> = [null, null, null];
  sockets3.forEach((socket, index) => socket.on('room:state', state => { latest[index] = state; }));
  for (let i = 0; i < 3; i++) success(await emit(sockets3[i], 'room:choose-faction', {
    roomCode: a.roomCode, reconnectToken: receipts[i].reconnectToken, faction: factions[i],
  }));
  for (let i = 0; i < 3; i++) success(await emit(sockets3[i], 'room:ready', {
    roomCode: a.roomCode, reconnectToken: receipts[i].reconnectToken, ready: true,
  }));
  success(await emit(wei, 'game:resign', { roomCode: a.roomCode, reconnectToken: a.reconnectToken }));
  await pause();
  assert.equal(latest.every(state => state?.game?.placements.wei === 3 && state.game?.turn === 'shu'), true);
  assert.equal(latest.every(state => state?.game?.pieces.every(piece => piece.faction !== 'wei')), true);
  success(await emit(shu, 'room:leave', { roomCode: a.roomCode, reconnectToken: b.reconnectToken }));
  await pause();
  assert.equal(latest[0]?.game?.winner, 'wu');
  assert.equal(latest[2]?.game?.placements.shu, 2);
  assert.equal(latest[2]?.game?.placements.wu, 1);
  const departed = await emit(shu, 'game:move', { roomCode: a.roomCode, reconnectToken: b.reconnectToken,
    intent: { requestId: 'departed01', version: latest[2]!.version, pieceId: 'shu-pawn-2-3', to: { x: 2, y: 4 } } });
  assert.equal(departed.ok, false);
});
