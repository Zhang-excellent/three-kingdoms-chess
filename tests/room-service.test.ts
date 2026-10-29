import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomService } from '../server/room-service.ts';
import type { Faction } from '../src/game.ts';
import type { ClientAck, MoveIntent, SessionReceipt } from '../src/online.ts';

function receipt(result: ReturnType<RoomService['createRoom']>): SessionReceipt {
  assert.equal(result.ack.ok, true);
  if (!result.ack.ok) assert.fail('room action failed');
  return result.ack.data;
}

function failure<T>(result: { ack: ClientAck<T> }, code: string) {
  assert.equal(result.ack.ok, false);
  if (result.ack.ok) assert.fail('expected rejection');
  assert.equal(result.ack.code, code);
}

function intent(requestId: string, version: number, pieceId: string, x: number, y: number): MoveIntent {
  return { requestId, version, pieceId, to: { x, y } };
}

function startedRoom() {
  const service = new RoomService();
  const first = receipt(service.createRoom('001234', '阿魏', 'socket-wei'));
  const second = receipt(service.joinRoom(first.roomCode, '阿蜀', 'socket-shu') as ReturnType<RoomService['createRoom']>);
  const third = receipt(service.joinRoom(first.roomCode, '阿吴', 'socket-wu') as ReturnType<RoomService['createRoom']>);
  const players = [first, second, third];
  for (const [index, faction] of (['wei', 'shu', 'wu'] as Faction[]).entries()) {
    const result = service.chooseFaction(first.roomCode, players[index].reconnectToken, faction, 1);
    assert.equal(result.ack.ok, true);
  }
  for (const player of players) {
    const result = service.setReady(first.roomCode, player.reconnectToken, true, 1);
    assert.equal(result.ack.ok, true);
  }
  const room = service.getRoom(first.roomCode)!;
  assert.equal(room.phase, 'playing'); assert.equal(room.game?.pieces.length, 29);
  return { service, code: first.roomCode, players, room };
}

test('three players claim unique factions, ready, and start one authoritative game', () => {
  const { service, code, players, room } = startedRoom();
  assert.deepEqual(room.players.map(player => player.faction), ['wei', 'shu', 'wu']);
  assert.equal(room.players.every(player => player.ready && player.online), true);
  const duplicate = service.chooseFaction(code, players[1].reconnectToken, 'wei', 1);
  assert.equal(duplicate.ack.ok, false);
  assert.equal(room.game?.turn, 'wei'); assert.equal(room.game?.turnSlot, 0);
});

test('a room rejects a fourth player and separate rooms never share state', async () => {
  const { service, code, players, room } = startedRoom();
  const waiting = receipt(service.createRoom('123456', '房主', 'waiting-1'));
  receipt(service.joinRoom(waiting.roomCode, '二号', 'waiting-2') as ReturnType<RoomService['createRoom']>);
  receipt(service.joinRoom(waiting.roomCode, '三号', 'waiting-3') as ReturnType<RoomService['createRoom']>);
  const full = service.joinRoom(waiting.roomCode, '第四人', 'waiting-4');
  assert.equal(full.ack.ok, false); if (!full.ack.ok) assert.equal(full.ack.code, 'ROOM_FULL');
  const other = receipt(service.createRoom('234567', '另一桌', 'other-socket'));
  assert.notEqual(other.roomCode, code);
  const before = service.getRoom(other.roomCode)!.version;
  const moved = await service.submitMove(code, players[0].reconnectToken, intent('roomone01', room.version, 'wei-pawn-0-6', 0, 5));
  assert.equal(moved.ack.ok, true);
  assert.equal(service.getRoom(other.roomCode)!.version, before);
  assert.equal(service.getRoom(other.roomCode)!.game, null);
});

test('server enforces faction ownership, turn, legal moves, and three-slot order', async () => {
  const { service, code, players, room } = startedRoom();
  failure(await service.submitMove(code, players[1].reconnectToken, intent('wrongturn1', room.version, 'wei-pawn-0-6', 0, 5)), 'NOT_YOUR_TURN');
  failure(await service.submitMove(code, players[0].reconnectToken, intent('wrongpiece', room.version, 'shu-pawn-2-3', 2, 4)), 'NOT_YOUR_PIECE');
  failure(await service.submitMove(code, players[0].reconnectToken, intent('illegal001', room.version, 'wei-pawn-0-6', 1, 6)), 'ILLEGAL_MOVE');
  const sequence = [
    [0, 'wei-pawn-0-6', 0, 5], [1, 'shu-pawn-2-3', 2, 4], [2, 'wu-pawn-6-3', 6, 4],
    [0, 'wei-pawn-4-6', 4, 5], [1, 'shu-pawn-0-3', 0, 4], [2, 'wu-pawn-8-3', 8, 4],
    [0, 'wei-pawn-2-6', 2, 5], [1, 'shu-pawn-4-3', 4, 4], [2, 'wu-feng-5-2', 5, 3],
  ] as const;
  for (const [index, [playerIndex, piece, x, y]] of sequence.entries()) {
    const result = await service.submitMove(code, players[playerIndex].reconnectToken,
      intent(`sequence${index}`, room.version, piece, x, y));
    assert.equal(result.ack.ok, true);
    if (index === 0) failure(await service.submitMove(code, players[1].reconnectToken,
      intent('allypiece1', room.version, 'wu-pawn-6-3', 6, 4)), 'NOT_YOUR_PIECE');
  }
  assert.deepEqual(room.game?.history.map(move => move.turnSlot), [0, 1, 2, 0, 1, 2, 0, 1, 2]);
  assert.equal(room.game?.turn, 'wei'); assert.equal(room.game?.turnSlot, 0);
});

test('serial processing, versions, and request ids prevent double moves', async () => {
  const { service, code, players, room } = startedRoom();
  const version = room.version;
  const firstIntent = intent('duplicate1', version, 'wei-pawn-0-6', 0, 5);
  const [first, concurrent] = await Promise.all([
    service.submitMove(code, players[0].reconnectToken, firstIntent),
    service.submitMove(code, players[0].reconnectToken, intent('concurrent1', version, 'wei-pawn-2-6', 2, 5)),
  ]);
  assert.equal(first.ack.ok, true); failure(concurrent, 'STALE_VERSION');
  assert.equal(room.game?.history.length, 1);
  const duplicate = await service.submitMove(code, players[0].reconnectToken, firstIntent);
  assert.equal(duplicate.ack.ok, true); assert.equal(room.game?.history.length, 1);
  failure(await service.submitMove(code, players[0].reconnectToken,
    intent('duplicate1', version, 'wei-pawn-4-6', 4, 5)), 'REQUEST_ID_REUSED');
  failure(await service.submitMove(code, players[1].reconnectToken,
    intent('stale0001', version, 'shu-pawn-2-3', 2, 4)), 'STALE_VERSION');
});

test('only the current faction may offer a draw and all surviving factions must accept', async () => {
  const { service, code, players, room } = startedRoom();
  failure(await service.offerDraw(code, players[1].reconnectToken, 'socket-shu'), 'NOT_YOUR_TURN');
  const offered = await service.offerDraw(code, players[0].reconnectToken, 'socket-wei');
  assert.equal(offered.ack.ok, true);
  assert.equal(room.drawOffer?.proposer, 'wei');
  assert.deepEqual(room.drawOffer?.eligible, ['wei', 'shu', 'wu']);
  assert.deepEqual(room.drawOffer?.votes, { wei: 'accept' });
  failure(await service.offerDraw(code, players[0].reconnectToken, 'socket-wei'), 'DRAW_OFFER_PENDING');
  failure(await service.submitMove(code, players[0].reconnectToken,
    intent('drawpause1', room.version, 'wei-pawn-0-6', 0, 5), 'socket-wei'), 'DRAW_OFFER_PENDING');

  const offerId = room.drawOffer!.id;
  failure(await service.respondDraw(code, players[0].reconnectToken, offerId, 'accept', 'socket-wei'), 'DRAW_ALREADY_ACCEPTED');
  const acceptedByShu = await service.respondDraw(code, players[1].reconnectToken, offerId, 'accept', 'socket-shu');
  assert.equal(acceptedByShu.ack.ok, true);
  assert.equal(room.phase, 'playing');
  assert.deepEqual(room.drawOffer?.votes, { wei: 'accept', shu: 'accept' });
  const rejectedByWu = await service.respondDraw(code, players[2].reconnectToken, offerId, 'reject', 'socket-wu');
  assert.equal(rejectedByWu.ack.ok, true);
  assert.equal(room.drawOffer, null);
  assert.equal(room.phase, 'playing');

  assert.equal((await service.offerDraw(code, players[0].reconnectToken, 'socket-wei')).ack.ok, true);
  const secondOfferId = service.getRoom(code)!.drawOffer!.id;
  failure(await service.respondDraw(code, players[1].reconnectToken, offerId, 'accept', 'socket-shu'), 'STALE_DRAW_OFFER');
  assert.equal((await service.respondDraw(code, players[1].reconnectToken, secondOfferId, 'accept', 'socket-shu')).ack.ok, true);
  assert.equal((await service.respondDraw(code, players[2].reconnectToken, secondOfferId, 'accept', 'socket-wu')).ack.ok, true);
  assert.equal(room.phase, 'finished');
  assert.equal(room.game?.status, 'finished');
  assert.equal(room.game?.winner, null);
  assert.deepEqual(room.game?.results, { wei: 'draw', shu: 'draw', wu: 'draw' });
  assert.equal(room.drawOffer, null);
});

test('draw voting uses only the two surviving factions and keeps the eliminated faction defeated', async () => {
  const { service, code, players, room } = startedRoom();
  assert.equal((await service.resignRoom(code, players[2].reconnectToken, 'socket-wu')).ack.ok, true);
  assert.equal(room.game?.results.wu, 'lost');
  assert.equal(room.game?.turn, 'wei');
  assert.equal((await service.offerDraw(code, players[0].reconnectToken, 'socket-wei')).ack.ok, true);
  assert.deepEqual(room.drawOffer?.eligible, ['wei', 'shu']);
  const offerId = room.drawOffer!.id;
  assert.equal((await service.respondDraw(code, players[1].reconnectToken, offerId, 'accept', 'socket-shu')).ack.ok, true);
  assert.equal(room.phase, 'finished');
  assert.deepEqual(room.game?.results, { wei: 'draw', shu: 'draw', wu: 'lost' });
  assert.equal(room.game?.winner, null);
});

test('disconnect keeps the seat and a secret token resumes without duplicating it', () => {
  const { service, code, players, room } = startedRoom();
  service.disconnect('socket-shu');
  assert.equal(room.players[1].online, false); assert.equal(room.players.length, 3);
  const bad = service.resumeRoom(code, 'guessable-name-is-not-a-token', 'attacker');
  assert.equal(bad.ack.ok, false);
  const resumed = service.resumeRoom(code, players[1].reconnectToken, 'socket-shu-new');
  assert.equal(resumed.ack.ok, true); assert.equal(room.players[1].online, true);
  assert.equal(room.players[1].socketId, 'socket-shu-new'); assert.equal(room.players.length, 3);
});

test('waiting player leaves, frees faction and seat, and last exit deletes room', async () => {
  const service = new RoomService();
  const a = receipt(service.createRoom('123456', '房主', 'a'));
  const b = receipt(service.joinRoom(a.roomCode, '第二人', 'b') as ReturnType<RoomService['createRoom']>);
  service.chooseFaction(a.roomCode, b.reconnectToken, 'shu', 1, 'b');
  service.setReady(a.roomCode, b.reconnectToken, true, 1, 'b');
  assert.equal((await service.leaveRoom(a.roomCode, b.reconnectToken, 'b')).ack.ok, true);
  assert.equal(service.getRoom(a.roomCode)?.players.length, 1);
  assert.equal(service.resumeRoom(a.roomCode, b.reconnectToken, 'b-new').ack.ok, false);
  const c = receipt(service.joinRoom(a.roomCode, '新人', 'c') as ReturnType<RoomService['createRoom']>);
  assert.equal(service.chooseFaction(a.roomCode, c.reconnectToken, 'shu', 1, 'c').ack.ok, true);
  await service.leaveRoom(a.roomCode, a.reconnectToken, 'a');
  await service.leaveRoom(a.roomCode, c.reconnectToken, 'c');
  assert.equal(service.getRoom(a.roomCode), undefined);
});

test('lobby disconnect cancels readiness, reconnect beats expiry, and offline seat is releasable', async () => {
  const service = new RoomService(() => {}, 25);
  const a = receipt(service.createRoom('123456', '房主', 'a'));
  const b = receipt(service.joinRoom(a.roomCode, '第二人', 'b') as ReturnType<RoomService['createRoom']>);
  service.chooseFaction(a.roomCode, b.reconnectToken, 'shu', 1, 'b');
  service.setReady(a.roomCode, b.reconnectToken, true, 1, 'b');
  service.disconnect('b');
  assert.equal(service.getRoom(a.roomCode)?.players[1].ready, false);
  assert.equal(service.getRoom(a.roomCode)?.players[1].online, false);
  assert.ok(service.getRoom(a.roomCode)?.players[1].offlineUntil);
  assert.equal(service.releaseOffline(a.roomCode, a.reconnectToken, b.playerId, 'a').ack.ok, true);
  assert.equal(service.resumeRoom(a.roomCode, b.reconnectToken, 'b2').ack.ok, false);
  const c = receipt(service.joinRoom(a.roomCode, '第三人', 'c') as ReturnType<RoomService['createRoom']>);
  assert.equal(service.releaseOffline(a.roomCode, a.reconnectToken, c.playerId, 'a').ack.ok, false);
  service.disconnect('c');
  assert.equal(service.resumeRoom(a.roomCode, c.reconnectToken, 'c2').ack.ok, true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(service.getRoom(a.roomCode)?.players.length, 2);
  service.disconnect('c2');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(service.getRoom(a.roomCode)?.players.length, 1);
});

test('one socket has one seat; consecutive leave and create gets a new canonical room', async () => {
  const service = new RoomService();
  const a = receipt(service.createRoom('123456', '甲', 'same'));
  assert.equal(receipt(service.createRoom('123456', '甲', 'same')).roomCode, a.roomCode);
  const other = receipt(service.createRoom('234567', '乙', 'other'));
  const rejected = service.joinRoom(other.roomCode, '甲', 'same');
  assert.equal(rejected.ack.ok, false);
  await service.leaveRoom(a.roomCode, a.reconnectToken, 'same');
  const b = receipt(service.createRoom('345678', '甲', 'same'));
  assert.notEqual(b.roomCode, a.roomCode);
  assert.equal(service.getRoom(a.roomCode), undefined);
});

test('resignation and active exit mark losses once, while finished game rejects moves', async () => {
  const { service, code, players, room } = startedRoom();
  const first = await service.resignRoom(code, players[0].reconnectToken, 'socket-wei');
  assert.equal(first.ack.ok, true);
  assert.equal(room.game?.results.wei, 'lost');
  assert.equal(room.game?.turn, 'shu');
  assert.equal(room.game?.pieces.some(piece => piece.faction === 'wei'), false);
  assert.equal((await service.resignRoom(code, players[0].reconnectToken, 'socket-wei')).ack.ok, false);
  const second = await service.leaveRoom(code, players[1].reconnectToken, 'socket-shu');
  assert.equal(second.ack.ok, true);
  assert.equal(room.game?.results.shu, 'lost');
  assert.equal(room.game?.results.wu, 'won');
  assert.equal(room.game?.winner, 'wu');
  assert.equal(room.players.length, 2);
  assert.equal((await service.submitMove(code, players[2].reconnectToken,
    intent('afterend01', room.version, 'wu-pawn-6-3', 6, 4), 'socket-wu')).ack.ok, false);
  assert.equal((await service.leaveRoom(code, players[0].reconnectToken, 'socket-wei')).ack.ok, true);
  assert.equal(room.game?.results.wei, 'lost');
});

test('new rooms use exact six-digit codes, preserve zeros, reject collisions, and keep one seat per socket', async () => {
  const service = new RoomService();
  for (const invalid of ['12345', '1234567', 'ABC123', 123456, '12 456']) {
    const result = service.createRoom(invalid, '甲', 'bad');
    failure(result, 'INVALID_ROOM_CODE');
  }
  const a = receipt(service.createRoom('001234', '甲', 'a'));
  assert.equal(a.roomCode, '001234');
  assert.equal(a.state.code, '001234');
  assert.equal(receipt(service.createRoom('001234', '甲', 'a')).playerId, a.playerId);
  failure(service.createRoom('001234', '乙', 'b'), 'ROOM_CODE_TAKEN');
  failure(service.createRoom('123456', '甲', 'a'), 'ALREADY_IN_ROOM');
  assert.equal(receipt(service.joinRoom('001234', '乙', 'b') as ReturnType<RoomService['createRoom']>).roomCode, '001234');
  failure(service.joinRoom('12345', '丙', 'c'), 'INVALID_ROOM_CODE');
  failure(service.joinRoom('123456', '丙', 'c'), 'ROOM_NOT_FOUND');
  assert.equal(service.watchRoom('001234', 'viewer').ack.ok, true);
  assert.equal(service.watchRoom('ABC123', 'viewer').ack.ok, false);
  await service.leaveRoom('001234', a.reconnectToken, 'a');
  assert.equal(service.getRoom('001234')?.players.length, 1);
});

test('finished game enters same-room next lobby, keeps old result until three online players ready, and rejects stale actions', async () => {
  const { service, code, players, room } = startedRoom();
  const initialId = room.players.map(player => player.id);
  const moved = await service.submitMove(code, players[0].reconnectToken,
    intent('roundone01', room.version, 'wei-pawn-0-6', 0, 5), 'socket-wei');
  assert.equal(moved.ack.ok, true);
  await service.resignRoom(code, players[0].reconnectToken, 'socket-wei');
  await service.resignRoom(code, players[1].reconnectToken, 'socket-shu');
  assert.equal(room.phase, 'finished');
  const previous = structuredClone(room.game);
  const finishedVersion = room.version;
  failure(await service.rematchRoom(code, players[0].reconnectToken, finishedVersion - 1, 'socket-wei'), 'STALE_VERSION');
  failure(await service.rematchRoom(code, players[0].reconnectToken, finishedVersion, 'socket-wu'), 'NOT_ACTIVE_CONNECTION');
  assert.equal((await service.rematchRoom(code, players[0].reconnectToken, finishedVersion, 'socket-wei')).ack.ok, true);
  assert.equal(room.code, code); assert.equal(room.round, 2); assert.equal(room.phase, 'lobby');
  assert.deepEqual(room.game, previous);
  assert.deepEqual(room.players.map(player => player.id), initialId);
  assert.deepEqual(room.players.map(player => player.faction), ['wei', 'shu', 'wu']);
  assert.equal(room.players.every(player => !player.ready), true);
  failure(await service.rematchRoom(code, players[0].reconnectToken, finishedVersion, 'socket-wei'), 'GAME_NOT_FINISHED');
  failure(service.setReady(code, players[0].reconnectToken, true, 1, 'socket-wei'), 'STALE_ROUND');
  failure(service.chooseFaction(code, players[0].reconnectToken, 'wu', 1, 'socket-wei'), 'STALE_ROUND');
  service.disconnect('socket-wu');
  assert.equal(service.setReady(code, players[0].reconnectToken, true, 2, 'socket-wei').ack.ok, true);
  assert.equal(service.setReady(code, players[1].reconnectToken, true, 2, 'socket-shu').ack.ok, true);
  assert.equal(room.phase, 'lobby');
  assert.equal(service.resumeRoom(code, players[2].reconnectToken, 'socket-wu-new').ack.ok, true);
  assert.equal(service.setReady(code, players[2].reconnectToken, true, 2, 'socket-wu-new').ack.ok, true);
  assert.equal(room.phase, 'playing'); assert.equal(room.round, 2);
  assert.equal(room.game?.history.length, 0); assert.equal(room.game?.lastMove, null);
  assert.equal(room.game?.turn, 'wei'); assert.equal(room.game?.pieces.length, 29);
  assert.deepEqual(room.game?.results, { wei: 'playing', shu: 'playing', wu: 'playing' });
  failure(await service.rematchRoom(code, players[0].reconnectToken, room.version, 'socket-wei'), 'GAME_NOT_FINISHED');
});

test('finished player exit opens original room for replacement and keeps last game visible', async () => {
  const { service, code, players, room } = startedRoom();
  await service.resignRoom(code, players[0].reconnectToken, 'socket-wei');
  await service.resignRoom(code, players[1].reconnectToken, 'socket-shu');
  assert.equal(room.phase, 'finished');
  const previous = structuredClone(room.game);
  await service.leaveRoom(code, players[1].reconnectToken, 'socket-shu');
  assert.equal(room.phase, 'lobby'); assert.equal(room.round, 2);
  assert.deepEqual(room.game, previous); assert.equal(room.players.length, 2);
  const next = receipt(service.joinRoom(code, '新蜀', 'socket-new') as ReturnType<RoomService['createRoom']>);
  assert.equal(next.roomCode, code);
  assert.equal(service.chooseFaction(code, next.reconnectToken, 'shu', 2, 'socket-new').ack.ok, true);
  for (const [player, socketId] of [[players[0], 'socket-wei'], [players[2], 'socket-wu'], [next, 'socket-new']] as const)
    assert.equal(service.setReady(code, player.reconnectToken, true, 2, socketId).ack.ok, true);
  assert.equal(room.phase, 'playing'); assert.equal(room.game?.history.length, 0);
});
