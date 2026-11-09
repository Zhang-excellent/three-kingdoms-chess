import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuthService } from '../server/auth-service.ts';
import { RoomService } from '../server/room-service.ts';
import { createOnlineServer } from '../server/create-server.ts';
import { replayArchivedGame } from '../src/game-replay.ts';
import type { ArchivedGameRecord, RecentGameSummary } from '../src/game-history.ts';
import type { MoveIntent } from '../src/online.ts';

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function tempDb(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'three-chess-history-'));
  temporaryDirectories.push(directory);
  return resolve(directory, 'auth.sqlite');
}

async function register(auth: AuthService, username: string, ip = '127.0.0.1') {
  const result = await auth.register(username, '1234', true, ip);
  assert.equal(result.ok, true);
  if (!result.ok || !result.sessionToken) assert.fail('account registration failed');
  return { user: result.user, cookie: `three_chess_session=${result.sessionToken}` };
}

function chooseAndReady(service: RoomService, code: string, players: Array<{ token: string; socket: string }>) {
  for (const [index, player] of players.entries()) {
    const chosen = service.chooseFaction(code, player.token, ['wei', 'shu', 'wu'][index] as 'wei' | 'shu' | 'wu', 1);
    assert.equal(chosen.ack.ok, true);
  }
  ready(service, code, players);
}

function ready(service: RoomService, code: string, players: Array<{ token: string; socket: string }>) {
  for (const player of players) {
    const result = service.setReady(code, player.token, true, service.getRoom(code)!.round);
    assert.equal(result.ack.ok, true);
  }
}

async function rematch(service: RoomService, code: string, player: { token: string; socket: string }) {
  const room = service.getRoom(code)!;
  const result = await service.rematchRoom(code, player.token, room.version, player.socket);
  assert.equal(result.ack.ok, true);
}

function intent(requestId: string, version: number, pieceId: string, x: number, y: number): MoveIntent {
  return { requestId, version, pieceId, to: { x, y } };
}

test('disconnect timeout eliminations are retained as timeout events in completed history', async () => {
  const auth = new AuthService(':memory:');
  const accounts = [
    await register(auth, '超时魏'),
    await register(auth, '超时蜀'),
    await register(auth, '超时吴'),
  ];
  const records: ArchivedGameRecord[] = [];
  const service = new RoomService(() => {}, 20, 20, record => {
    records.push(record);
    auth.saveCompletedGame(record);
  });
  const sockets = ['timeout-wei', 'timeout-shu', 'timeout-wu'];
  sockets.forEach((socket, index) => service.setSocketAccount(socket, accounts[index].user.id));
  const first = service.createRoom('660002', '超时魏', sockets[0]);
  if (!first.ack.ok) assert.fail(first.ack.error);
  const joined = sockets.slice(1).map((socket, index) =>
    service.joinRoom('660002', `超时${['蜀', '吴'][index]}`, socket));
  joined.forEach(result => assert.equal(result.ack.ok, true));
  const receipts = [first.ack.data, ...joined.map(result => {
    if (!result.ack.ok) assert.fail(result.ack.error);
    return result.ack.data;
  })];
  const players = receipts.map((receipt, index) => ({ token: receipt.reconnectToken, socket: sockets[index] }));
  chooseAndReady(service, '660002', players);
  service.disconnect(sockets[0]);
  await new Promise(resolveWait => setTimeout(resolveWait, 35));
  service.disconnect(sockets[1]);
  await new Promise(resolveWait => setTimeout(resolveWait, 35));
  const record = records.at(-1)!;
  assert.equal(record.endReason, 'timeout');
  assert.equal(record.events.filter(event => event.type === 'resign' && event.cause === 'timeout').length, 2);
  assert.equal(auth.recentGames(accounts[0].user.id)[0].result, 'lost');
  auth.close();
});

test('completed online games are stored once per game, shared by account participants, and replay with terminal state', async () => {
  const databasePath = tempDb();
  let currentTime = Date.UTC(2026, 10, 8, 10, 0, 0);
  const now = () => currentTime;
  const auth = new AuthService(databasePath, { now });
  const accounts = [
    await register(auth, '记录魏'),
    await register(auth, '记录蜀'),
    await register(auth, '记录吴'),
  ];
  const unrelated = await register(auth, '无关账号');
  const records: ArchivedGameRecord[] = [];
  const service = new RoomService(() => {}, 60_000, 180_000, record => {
    records.push(record);
    auth.saveCompletedGame(record);
  }, now);

  const sockets = ['hist-wei', 'hist-shu', 'hist-wu'];
  sockets.forEach((socket, index) => service.setSocketAccount(socket, accounts[index].user.id));
  const firstResult = service.createRoom('660001', '记录魏', sockets[0], true);
  if (!firstResult.ack.ok) assert.fail(firstResult.ack.error);
  const joined = sockets.slice(1).map((socket, index) =>
    service.joinRoom('660001', `记录${['蜀', '吴'][index]}`, socket));
  joined.forEach(result => assert.equal(result.ack.ok, true));
  const receipts = [firstResult.ack.data, ...joined.map(result => {
    if (!result.ack.ok) assert.fail(result.ack.error);
    return result.ack.data;
  })];
  const players = receipts.map((receipt, index) => ({ token: receipt.reconnectToken, socket: sockets[index] }));
  assert.equal(records.length, 0);
  chooseAndReady(service, '660001', players);
  assert.equal(service.getRoom('660001')!.gameId !== null, true);
  const firstGameId = service.getRoom('660001')!.gameId!;
  const move = await service.submitMove('660001', players[0].token,
    intent('historymove1', service.getRoom('660001')!.version, 'wei-pawn-0-6', 0, 5), players[0].socket);
  assert.equal(move.ack.ok, true);
  assert.equal((await service.resignRoom('660001', players[2].token, players[2].socket)).ack.ok, true);
  currentTime += 1_000;
  assert.equal((await service.resignRoom('660001', players[1].token, players[1].socket)).ack.ok, true);
  const firstRecord = records.at(-1)!;
  assert.equal(firstRecord.id, firstGameId);
  assert.equal(firstRecord.endReason, 'resignation');
  assert.equal(firstRecord.moveCount, 1);
  assert.deepEqual(firstRecord.participants.map(player => player.result).sort(), ['lost', 'lost', 'won']);
  assert.equal(firstRecord.events.some(event => event.type === 'resign' && event.cause === 'resignation'), true);
  assert.equal(firstRecord.events.some(event => event.type === 'result'), true);
  assert.equal(firstRecord.initialPieces.length, 29);
  const replay = replayArchivedGame(firstRecord);
  if (!replay.ok) assert.fail(replay.error);
  assert.equal(replay.replay.moves.length, 1);
  assert.equal(replay.replay.frames.at(-1)?.status, 'finished');
  assert.equal(replay.replay.frames.at(-1)?.winner, 'wei');
  assert.equal(replay.replay.frames.at(-1)?.pieces.every(piece => piece.faction === 'wei'), true);
  assert.deepEqual(replay.replay.frames.at(-1)?.eliminated.sort(), ['shu', 'wu']);

  auth.saveCompletedGame(firstRecord);
  auth.saveCompletedGame(firstRecord);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM game_records').get() as { count: number }).count, 1);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM game_participants').get() as { count: number }).count, 3);
  database.close();

  for (const account of accounts) assert.equal(auth.recentGames(account.user.id)[0].id, firstGameId);
  assert.equal(auth.gameForUser(unrelated.user.id, firstGameId), null);
  assert.equal(auth.gameForUser(accounts[1].user.id, firstGameId)?.id, firstGameId);

  await rematch(service, '660001', players[0]);
  currentTime += 1_000;
  ready(service, '660001', players);
  const secondGameId = service.getRoom('660001')!.gameId!;
  assert.notEqual(secondGameId, firstGameId);
  assert.equal((await service.offerDraw('660001', players[0].token, players[0].socket)).ack.ok, true);
  const secondOffer = service.getRoom('660001')!.drawOffer!;
  assert.equal((await service.respondDraw('660001', players[1].token, secondOffer.id, 'accept', players[1].socket)).ack.ok, true);
  assert.equal((await service.respondDraw('660001', players[2].token, secondOffer.id, 'accept', players[2].socket)).ack.ok, true);
  currentTime += 1_000;
  assert.equal(records.at(-1)?.id, secondGameId);
  assert.equal(records.at(-1)?.endReason, 'agreement_draw');
  assert.deepEqual(records.at(-1)?.participants.map(player => player.result), ['draw', 'draw', 'draw']);

  await rematch(service, '660001', players[0]);
  currentTime += 1_000;
  ready(service, '660001', players);
  const thirdGameId = service.getRoom('660001')!.gameId!;
  assert.equal((await service.resignRoom('660001', players[0].token, players[0].socket)).ack.ok, true);
  assert.equal((await service.offerDraw('660001', players[1].token, players[1].socket)).ack.ok, true);
  const thirdOffer = service.getRoom('660001')!.drawOffer!;
  assert.equal((await service.respondDraw('660001', players[2].token, thirdOffer.id, 'accept', players[2].socket)).ack.ok, true);
  currentTime += 1_000;
  assert.equal(records.at(-1)?.id, thirdGameId);
  assert.deepEqual(records.at(-1)?.participants.map(player => player.result), ['lost', 'draw', 'draw']);

  await rematch(service, '660001', players[0]);
  currentTime += 1_000;
  ready(service, '660001', players);
  const fourthGameId = service.getRoom('660001')!.gameId!;
  assert.equal((await service.leaveRoom('660001', players[0].token, players[0].socket)).ack.ok, true);
  currentTime += 1_000;
  assert.equal((await service.resignRoom('660001', players[1].token, players[1].socket)).ack.ok, true);
  const exitRecord = records.at(-1)!;
  assert.equal(exitRecord.id, fourthGameId);
  assert.equal(exitRecord.endReason, 'resignation');
  assert.equal(exitRecord.events.some(event => event.type === 'resign' && event.cause === 'exit'), true);
  assert.equal(exitRecord.participants.find(player => player.userId === accounts[0].user.id)?.result, 'lost');
  assert.equal(auth.recentGames(accounts[0].user.id)[0].id, fourthGameId);
  assert.notEqual(firstGameId, secondGameId);
  assert.notEqual(secondGameId, thirdGameId);
  assert.notEqual(thirdGameId, fourthGameId);

  for (let index = 0; index < 4; index++) {
    const endedAt = currentTime + (index + 1) * 1_000;
    auth.saveCompletedGame({
      ...thirdRecord(records),
      id: `synthetic-${index}`,
      roomCode: `67000${index}`,
      round: 1,
      startedAt: endedAt - 1_000,
      endedAt,
    });
  }
  const recent = auth.recentGames(accounts[0].user.id);
  assert.equal(recent.length, 5);
  assert.deepEqual(recent.map(game => game.endedAt), [...recent.map(game => game.endedAt)].sort((a, b) => b - a));
  assert.equal(recent.some(game => game.id === firstGameId), false);
  const retained = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((retained.prepare('SELECT COUNT(*) AS count FROM game_records').get() as { count: number }).count, 8);
  retained.close();

  const { server, origin } = await startServer(auth);
  try {
    const recentResponse = await fetch(`${origin}/three-chess/api/games/recent`, { headers: { Cookie: accounts[0].cookie } });
    assert.equal(recentResponse.status, 200);
    const recentBody = await recentResponse.json() as { games: RecentGameSummary[] };
    assert.equal(recentBody.games.length, 5);
    const ownerGame = await fetch(`${origin}/three-chess/api/games/${fourthGameId}`, { headers: { Cookie: accounts[0].cookie } });
    assert.equal(ownerGame.status, 200);
    const otherGame = await fetch(`${origin}/three-chess/api/games/${fourthGameId}`, { headers: { Cookie: unrelated.cookie } });
    assert.equal(otherGame.status, 404);
    assert.equal((await fetch(`${origin}/three-chess/api/games/recent`)).status, 401);
  } finally {
    await closeServer(server);
  }

  const reopened = new AuthService(databasePath);
  try {
    assert.equal(reopened.recentGames(accounts[0].user.id)[0].id, recent[0].id);
    assert.equal(reopened.gameForUser(accounts[0].user.id, fourthGameId)?.id, fourthGameId);
  } finally {
    reopened.close();
  }
});

function thirdRecord(records: ArchivedGameRecord[]): ArchivedGameRecord {
  return structuredClone(records.find(record => record.moveCount === 0 && record.endReason === 'agreement_draw')
    ?? records.find(record => record.endReason === 'agreement_draw')
    ?? records.at(-1)!);
}

async function startServer(authService: AuthService) {
  const server = createOnlineServer({ authService, cookieSecure: false });
  await new Promise<void>(resolveListen => server.httpServer.listen(0, '127.0.0.1', resolveListen));
  return {
    server,
    origin: `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`,
  };
}

async function closeServer(server: ReturnType<typeof createOnlineServer>) {
  await new Promise<void>(resolveClose => server.io.close(() => resolveClose()));
  server.authService.close();
}
